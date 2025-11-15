import { StateGraph, MessagesAnnotation } from "@langchain/langgraph";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import createLLM from "../../config/llm.js";
import checkpointService from "../memory/checkpointService.js";
import ragieService from "./ragieService.js";
import subscriptionService from "../subscription/subscriptionService.js";
import prompts from "../../constants/prompts.json" with { type: "json" };
import logger from "../../utils/logger.js";
import { generateThreadId } from "../../utils/dateFormatter.js";
import { AppError } from "../../utils/errorHandler.js";
import workspaceService from "../workspace/workspaceService.js";

class GroqService {
  constructor() {
    this.llm = null;
    this.graph = null;
    this.initialized = false;
  }

  async initialize() {
    if (this.initialized) {
      return;
    }

    try {
      logger.info("Initializing Groq service");

      await subscriptionService.initialize();

      this.llm = createLLM();

      const checkpointer = await checkpointService.initialize();

      const workflow = new StateGraph(MessagesAnnotation)
        .addNode("chat", async (state) => {
          const response = await this.llm.invoke(state.messages);
          return { messages: [response] };
        })
        .addEdge("__start__", "chat")
        .addEdge("chat", "__end__");

      this.graph = workflow.compile({ checkpointer });
      this.initialized = true;

      logger.info("Groq service initialized successfully");
    } catch (error) {
      logger.error("Failed to initialize Groq service", { error: error.message });
      throw error;
    }
  }

  _getCurrentDateTime() {
    const now = new Date();
    return now.toLocaleString("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZoneName: "short",
    });
  }

  async _buildFeaturesDescription(userJid) {
    const tier = await subscriptionService.getUserTier(userJid);
    const config = subscriptionService.getTierConfig(tier);
    
    let features = "# Your Current Subscription\n";
    features += `*${config.name}*\n\n`;
    
    if (config.features.rag_enabled) {
      features += "✓ Knowledge base access enabled\n";
    } else {
      features += "✗ Knowledge base access (upgrade to Premium)\n";
    }
    
    if (config.features.enabled_tools.length > 0) {
      features += `✓ Advanced tools enabled: ${config.features.enabled_tools.join(", ")}\n`;
    } else {
      features += "✗ Advanced tools (upgrade to Mid or Premium tier)\n";
    }
    
    return features;
  }

  async _buildSystemPrompt(context, userJid, promptType = "ragbee") {
    const promptConfig = prompts[promptType];

    if (!promptConfig) {
      logger.warn(`Prompt type '${promptType}' not found, using default 'ragbee'`);
      promptType = "ragbee";
    }

    const datetime = this._getCurrentDateTime();
    const features = await this._buildFeaturesDescription(userJid);

    let systemPrompt = prompts[promptType].systemPrompt;
    systemPrompt = systemPrompt.replace("{DATETIME}", datetime);
    systemPrompt = systemPrompt.replace("{CONTEXT}", context);
    systemPrompt = systemPrompt.replace("{FEATURES}", features);

    return systemPrompt;
  }

  _extractContent(lastMessage) {
    if (typeof lastMessage?.content === "string") {
      return lastMessage.content;
    }

    if (Array.isArray(lastMessage?.content)) {
      return lastMessage.content.map((p) => p?.text || "").join("");
    }

    return String(lastMessage?.content || "");
  }

  async _createTieredLLM(userJid) {
    const enabledTools = await subscriptionService.getEnabledTools(userJid);
    
    if (!process.env.GROQ_API_KEY) {
      throw new Error("GROQ_API_KEY is not set in environment variables");
    }

    const { ChatGroq } = await import("@langchain/groq");
    const settings = (await import("../../constants/settings.json", { with: { type: "json" } })).default;

    return new ChatGroq({
      apiKey: process.env.GROQ_API_KEY,
      model: settings.groq.model,
      compound_custom: {
        tools: {
          enabled_tools: enabledTools,
        },
      },
    });
  }

  async chat(question, userJid, promptType = "ragbee") {
  if (!this.initialized) {
    await this.initialize();
  }

  try {
    logger.info("Processing chat request", { question, userJid, promptType });

    const threadId = generateThreadId(userJid);

    const hasRagAccess = await subscriptionService.hasFeatureAccess(userJid, "rag");
    
    let context = "";
    if (hasRagAccess) {
      const workspace = await workspaceService.getUserWorkspace(userJid);
      const workspaceId = workspace?.workspace_id || null;
      
      context = await ragieService.retrieveContext(
        question,
        userJid,
        workspaceId
      );
      logger.info("RAG context retrieved", {
        userJid,
        workspaceId,
        contextLength: context.length,
      });
    } else {
      context = "No knowledge base context available. Using general AI knowledge only.";
      logger.info("RAG access denied for user tier", { userJid });
    }

      const systemPrompt = await this._buildSystemPrompt(context, userJid, promptType);

      const tieredLLM = await this._createTieredLLM(userJid);

      const workflow = new StateGraph(MessagesAnnotation)
        .addNode("chat", async (state) => {
          const response = await tieredLLM.invoke(state.messages);
          return { messages: [response] };
        })
        .addEdge("__start__", "chat")
        .addEdge("chat", "__end__");

      const checkpointer = checkpointService.getCheckpointer();
      const tieredGraph = workflow.compile({ checkpointer });

      const config = { configurable: { thread_id: threadId } };

      const agentOutput = await tieredGraph.invoke(
        {
          messages: [new SystemMessage(systemPrompt), new HumanMessage(question)],
        },
        config
      );

      const lastMsg = agentOutput.messages[agentOutput.messages.length - 1];
      const reply = this._extractContent(lastMsg);

      logger.info("Successfully generated chat response", {
        question,
        userJid,
        replyLength: reply.length,
      });

      return reply;
    } catch (error) {
      logger.error("Error processing chat request", {
        question,
        userJid,
        error: error.message,
      });
      throw new AppError("Failed to process chat request", 500, {
        question,
        userJid,
      });
    }
  }
}

const groqService = new GroqService();
export default groqService;
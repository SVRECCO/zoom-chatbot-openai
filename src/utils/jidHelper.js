export function normalizeJid(jid) {
 if (!jid) return null;

 const baseId = jid.replace(/@xmpp\.zoom\.us$/i, "").trim();

 return `${baseId}@xmpp.zoom.us`;
}

export function extractBaseId(jid) {
 if (!jid) return null;
 return jid.replace(/@xmpp\.zoom\.us$/i, "").trim();
}

export function isValidJid(jid) {
 if (!jid || typeof jid !== "string") return false;

 const jidPattern = /^[a-z0-9]+@xmpp\.zoom\.us$/i;
 return jidPattern.test(jid);
}

export default {
 normalizeJid,
 extractBaseId,
 isValidJid,
};

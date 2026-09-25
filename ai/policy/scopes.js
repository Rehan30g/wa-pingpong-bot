const SCOPES = Object.freeze({
  GROUP: "group",
  DM: "dm",
  OWNER: "owner",
  ACTIVE_CHAT: "active_chat",
  READ: "read",
  WRITE: "write",
  SEND: "send",
  SCHEDULE: "schedule",
});

const CHANNEL_SCOPES = Object.freeze(new Set([SCOPES.GROUP, SCOPES.DM]));

const PERMISSION_SCOPES = Object.freeze(new Set([
  SCOPES.OWNER,
  SCOPES.ACTIVE_CHAT,
  SCOPES.READ,
  SCOPES.WRITE,
  SCOPES.SEND,
  SCOPES.SCHEDULE,
]));

const ALL_SCOPES = Object.freeze(new Set(Object.values(SCOPES)));

function isValidScope(scope) {
  return ALL_SCOPES.has(scope);
}

function isChannelScope(scope) {
  return CHANNEL_SCOPES.has(scope);
}

function isPermissionScope(scope) {
  return PERMISSION_SCOPES.has(scope);
}

function validateScopes(scopes) {
  if (!Array.isArray(scopes)) return false;
  return scopes.every((s) => isValidScope(s));
}

function validateChannelScopes(scopes) {
  if (!Array.isArray(scopes) || scopes.length === 0) return false;
  return scopes.every((s) => isChannelScope(s));
}

function validateRequiredScopes(scopes) {
  if (!Array.isArray(scopes)) return false;
  return scopes.every((s) => isPermissionScope(s));
}

module.exports = {
  SCOPES,
  CHANNEL_SCOPES,
  PERMISSION_SCOPES,
  ALL_SCOPES,
  isValidScope,
  isChannelScope,
  isPermissionScope,
  validateScopes,
  validateChannelScopes,
  validateRequiredScopes,
};


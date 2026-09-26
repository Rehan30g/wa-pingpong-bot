const { SCOPES, isChannelScope } = require("./scopes");

const REASON_CODES = Object.freeze({
  ALLOW: "ALLOW",
  DENIED_UNKNOWN_ACTOR: "DENIED_UNKNOWN_ACTOR",
  DENIED_EMPTY_PN: "DENIED_EMPTY_PN",
  DENIED_RAW_LID: "DENIED_RAW_LID",
  DENIED_UNVERIFIED_ACTOR: "DENIED_UNVERIFIED_ACTOR",
  DENIED_INVALID_PROVENANCE: "DENIED_INVALID_PROVENANCE",
  DENIED_UNKNOWN_CAPABILITY: "DENIED_UNKNOWN_CAPABILITY",
  DENIED_CAPABILITY_DISABLED: "DENIED_CAPABILITY_DISABLED",
  DENIED_OWNER_REQUIRED: "DENIED_OWNER_REQUIRED",
  DENIED_CHANNEL_MISMATCH: "DENIED_CHANNEL_MISMATCH",
  DENIED_INSUFFICIENT_SCOPES: "DENIED_INSUFFICIENT_SCOPES",
  DENIED_SCOPE_MISMATCH: "DENIED_SCOPE_MISMATCH",
  DENIED_CROSS_CHAT: "DENIED_CROSS_CHAT",
  DENIED_BROADCAST_WILDCARD: "DENIED_BROADCAST_WILDCARD",
  DENIED_ARBITRARY_DESTINATION: "DENIED_ARBITRARY_DESTINATION",
});

const VALID_PROVENANCES = Object.freeze(new Set([
  "runtime_inbound_message",
  "runtime_internal_task",
  "runtime_scheduler",
  "test_harness",
]));

function isRawLid(value) {
  if (typeof value !== "string") return false;
  const lower = value.toLowerCase();
  return lower.endsWith("@lid") || lower.includes("lid:");
}

function normalizePhone(value) {
  if (typeof value !== "string") return "";
  const digits = value.split(":")[0].split("@")[0].replace(/\D/g, "");
  if (!digits) return "";
  return digits.startsWith("0") ? `62${digits.slice(1)}` : digits;
}

function authorize({
  actor,
  capability,
  context = {},
  invocation = {},
}) {
  // 1. Validasi Actor (Fail-Closed)
  if (!actor || typeof actor !== "object") {
    return {
      allow: false,
      reasonCode: REASON_CODES.DENIED_UNKNOWN_ACTOR,
      message: "Actor tidak dikenal atau tidak disertakan oleh runtime",
    };
  }

  if (actor.isLid || isRawLid(actor.pn) || isRawLid(actor.jid)) {
    return {
      allow: false,
      reasonCode: REASON_CODES.DENIED_RAW_LID,
      message: "Raw LID tidak diizinkan sebagai identitas actor; harus menggunakan PN terverifikasi",
    };
  }

  const cleanPn = normalizePhone(actor.pn);
  if (!cleanPn) {
    return {
      allow: false,
      reasonCode: REASON_CODES.DENIED_EMPTY_PN,
      message: "Nomor telepon (PN) actor kosong atau tidak valid",
    };
  }

  // Wajib bernilai tepat boolean true; undefined, null, false, string, atau angka ditolak
  if (actor.verified !== true) {
    return {
      allow: false,
      reasonCode: REASON_CODES.DENIED_UNVERIFIED_ACTOR,
      message: "Actor belum terverifikasi oleh runtime (verified wajib bernilai boolean true)",
    };
  }

  // Validasi Provenance/Source
  if (!actor.provenance || !VALID_PROVENANCES.has(actor.provenance)) {
    return {
      allow: false,
      reasonCode: REASON_CODES.DENIED_INVALID_PROVENANCE,
      message: `Provenance/source actor '${actor.provenance}' tidak valid atau tidak berasal dari runtime`,
    };
  }

  // 2. Validasi Capability
  if (!capability || typeof capability !== "object") {
    return {
      allow: false,
      reasonCode: REASON_CODES.DENIED_UNKNOWN_CAPABILITY,
      message: "Capability tidak terdaftar",
    };
  }

  if (capability.enabled !== true) {
    return {
      allow: false,
      reasonCode: REASON_CODES.DENIED_CAPABILITY_DISABLED,
      message: `Capability '${capability.name || "unknown"}' sedang dinonaktifkan`,
    };
  }

  // 3. Validasi Scope (Channel one-of, Required Scopes all-of, Owner explicit)
  const activeChannel = context.channel || context.activeChannel || null;
  const activeScopes = Array.isArray(context.activeScopes) ? context.activeScopes : [];

  // Ambil channelScopes & requiredScopes
  let channelScopes = Array.isArray(capability.channelScopes) ? capability.channelScopes : [];
  let requiredScopes = Array.isArray(capability.requiredScopes) ? capability.requiredScopes : [];

  // Kompatibilitas jika capability lama hanya membawa allowedScopes
  if (channelScopes.length === 0 && requiredScopes.length === 0 && Array.isArray(capability.allowedScopes)) {
    channelScopes = capability.allowedScopes.filter((s) => isChannelScope(s));
    requiredScopes = capability.allowedScopes.filter((s) => !isChannelScope(s));
  }

  // Channel matching (one-of): jika capability mensyaratkan channel tertentu
  if (channelScopes.length > 0) {
    if (!activeChannel || !channelScopes.includes(activeChannel)) {
      return {
        allow: false,
        reasonCode: REASON_CODES.DENIED_CHANNEL_MISMATCH,
        message: `Channel '${activeChannel}' tidak diizinkan untuk capability '${capability.name}' (diizinkan: ${channelScopes.join(", ")})`,
      };
    }
  }

  // Owner explicit check
  if (requiredScopes.includes(SCOPES.OWNER) && !actor.isOwner) {
    return {
      allow: false,
      reasonCode: REASON_CODES.DENIED_OWNER_REQUIRED,
      message: `Capability '${capability.name}' memerlukan hak akses owner`,
    };
  }

  // Required scopes matching (all-of): semua requiredScopes non-channel wajib ada di activeScopes
  const missingRequired = requiredScopes.filter((s) => !activeScopes.includes(s));
  if (missingRequired.length > 0) {
    return {
      allow: false,
      reasonCode: REASON_CODES.DENIED_INSUFFICIENT_SCOPES,
      message: `Izin tidak lengkap untuk capability '${capability.name}': kekurangan scope [${missingRequired.join(", ")}] (aktif: [${activeScopes.join(", ")}])`,
    };
  }

  // 4. Validasi Destinasi dan Larangan Arbitrary Target
  const originChatId = context.originChatId ? String(context.originChatId).trim() : "";
  const destination = invocation.destination ? String(invocation.destination).trim() : "";

  // Periksa apakah argumen model mencoba menyuntikkan destinasi arbitrer (dilarang keras)
  const args = invocation.arguments && typeof invocation.arguments === "object" ? invocation.arguments : {};
  const modelInjectedTarget = args.destination || args.target || args.recipient || args.to;

  if (modelInjectedTarget !== undefined && modelInjectedTarget !== null && modelInjectedTarget !== "") {
    return {
      allow: false,
      reasonCode: REASON_CODES.DENIED_ARBITRARY_DESTINATION,
      message: "Model dilarang menentukan target/destinasi dalam argumen (destination/target/recipient/to); destinasi hanya boleh ditentukan oleh runtime",
    };
  }

  if (destination) {
    const lowerDest = destination.toLowerCase();
    // Tolak broadcast/wildcard
    if (
      lowerDest === "all" ||
      lowerDest === "everyone" ||
      lowerDest === "@broadcast" ||
      lowerDest.includes("broadcast") ||
      lowerDest.includes(",")
    ) {
      return {
        allow: false,
        reasonCode: REASON_CODES.DENIED_BROADCAST_WILDCARD,
        message: "Pengiriman massal, broadcast, atau wildcard dilarang keras oleh policy",
      };
    }

    if (isRawLid(destination)) {
      return {
        allow: false,
        reasonCode: REASON_CODES.DENIED_RAW_LID,
        message: "Destinasi tidak boleh berupa raw LID",
      };
    }

    // Cross-chat protection
    if (originChatId && destination !== originChatId) {
      return {
        allow: false,
        reasonCode: REASON_CODES.DENIED_CROSS_CHAT,
        message: `Upaya aksi lintas obrolan (cross-chat) ditolak (asal: ${originChatId}, tujuan: ${destination})`,
      };
    }
  }

  return {
    allow: true,
    reasonCode: REASON_CODES.ALLOW,
    message: "Aksi diizinkan oleh policy",
  };
}

module.exports = {
  authorize,
  REASON_CODES,
  isRawLid,
  normalizePhone,
};

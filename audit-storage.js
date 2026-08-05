const KEY = "vyntar-inspect-audits";

export function loadAudits() {
  if (typeof window === "undefined") return [];
  try {
    return JSON.parse(window.localStorage.getItem(KEY)) || [];
  } catch {
    return [];
  }
}

function persist(audits) {
  window.localStorage.setItem(KEY, JSON.stringify(audits));
}

export function saveAudit(record) {
  const all = loadAudits();
  all.unshift(record);
  try {
    persist(all);
    return all;
  } catch {
    // Storage full — drop the photo thumbnail from the oldest records and retry.
    for (let i = all.length - 1; i >= 0; i--) {
      if (all[i].photoThumb) {
        all[i] = { ...all[i], photoThumb: null };
        try {
          persist(all);
          return all;
        } catch {
          // keep trimming
        }
      }
    }
    return all; // record kept in memory for this session even if persistence failed
  }
}

export function deleteAudit(id) {
  const all = loadAudits().filter((a) => a.id !== id);
  try {
    persist(all);
  } catch {
    // ignore
  }
  return all;
}

export function clearAudits() {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    // ignore
  }
  return [];
}

export function auditsToCsv(audits) {
  const header = [
    "Audit ref",
    "Signed at",
    "Inspector",
    "Cert",
    "Equipment tag",
    "Category",
    "Site",
    "Inspection type",
    "Status",
    "Risk score",
    "Hazards",
    "Critical hazards",
  ];
  const escape = (value) => `"${String(value ?? "").replace(/"/g, '""')}"`;
  const rows = audits.map((a) =>
    [
      a.auditRef,
      a.signedAt,
      a.metadata?.inspector,
      a.metadata?.cert,
      a.metadata?.equipmentTag,
      a.metadata?.category,
      a.metadata?.site,
      a.metadata?.inspectionType,
      a.result?.overall_status,
      a.result?.risk_score,
      a.result?.hazards?.length ?? 0,
      a.result?.hazards?.filter((h) => h.severity === "CRITICAL").length ?? 0,
    ]
      .map(escape)
      .join(",")
  );
  return [header.map(escape).join(","), ...rows].join("\n");
}

export function downloadCsv(audits) {
  const blob = new Blob([auditsToCsv(audits)], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `vyntar-inspect-audits-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

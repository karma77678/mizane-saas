// Pure helpers for the aggregated AI review route: no database or network access, so they can be tested on their own.

export const reviewSchema = {
  type: "object",
  properties: {
    executiveSummary: { type: "string" },
    priorities: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          explanation: { type: "string" },
          suggestedAction: { type: "string" },
          severity: {
            type: "string",
            enum: ["critical", "high", "medium", "low", "info"],
          },
          relatedRuleCodes: { type: "array", items: { type: "string" } },
        },
        required: [
          "title",
          "explanation",
          "suggestedAction",
          "severity",
          "relatedRuleCodes",
        ],
        additionalProperties: false,
      },
    },
    limitations: { type: "string" },
  },
  required: ["executiveSummary", "priorities", "limitations"],
  additionalProperties: false,
} as const;

export const REVIEW_SYSTEM_PROMPT =
  "Tu es un assistant pédagogique d’audit comptable travaillant sur des constats agrégés pour une entreprise marocaine. Explique et hiérarchise les risques à partir des seuls chiffres, codes et intitulés fournis. Chaque constat porte un ruleTitle : c’est la définition exacte de la règle de contrôle, appuie ton explication dessus et ne donne pas à un code un autre sens. Un ruleTitle « Règle non référencée » signifie que la règle est inconnue : ne devine pas sa nature. Ne prétends pas certifier une conformité, ne cite pas de règle fiscale, taux, délai ou article de loi non inclus dans l’entrée, n’invente pas de faits, et ne propose jamais une écriture comptable chiffrée. Recommande une vérification humaine des pièces et des règles applicables à l’exercice. Rappelle que les résultats sont indicatifs.";

export const MAX_PRIORITIES = 6;

type Severity = "critical" | "high" | "medium" | "low" | "info";
export type ReviewRequest = {
  fiscalYear: number;
  summary: { entryCount: number; totalDebit: number; totalCredit: number; balanceDifference: number; findingsCount: number };
  findings: { ruleCode: string; severity: Severity; occurrences: number }[];
};
export type ReviewInput = ReturnType<typeof buildReviewInput>;

// Fixed titles of the audit engine's rules (artifacts/audit-maroc/src/lib/audit-engine.ts), so the model
// explains each code by what it actually checks instead of guessing from the code. A test keeps both in sync.
// Titles come from this table, never from the request: no client text can reach the model through them.
export const RULE_TITLES: Readonly<Record<string, string>> = {
  "BAL-01": "Balance ou périmètre importé déséquilibré",
  "BAL-02": "Solde inversé sur compte de tiers",
  "BAL-03": "Caisse créditrice",
  "CGNC-01": "Solde contraire au sens habituel de la classe",
  "DUP-01": "Risque de double comptabilisation",
  "ECR-01": "Pièce potentiellement déséquilibrée",
  "ECR-02": "Débit et crédit sur la même ligne",
  "ECR-03": "Compte non renseigné",
  "ECR-04": "Date absente ou à contrôler",
  "ECR-06": "Référence de pièce absente",
  "ECR-07": "Montant non interprétable",
  "ECR-08": "Montant négatif dans une colonne de sens",
  "FISC-01": "Dépassement du plafond de paiement en espèces",
  "FISC-02": "Pénalités ou amendes fiscales détectées",
  "FISC-03": "Incohérence du taux de TVA récupérable",
  "PER-01": "Date hors exercice sélectionné",
  "REG-01": "À vérifier — décaissement sur compte temporaire",
  "TVA-01": "Taux de TVA reconstitué à vérifier",
};
export const UNKNOWN_RULE_TITLE = "Règle non référencée";

// Only aggregates leave the server: the year, the totals, and per rule code its fixed title and count of findings.
export function buildReviewInput({ fiscalYear, summary, findings }: ReviewRequest) {
  return {
    fiscalYear,
    summary,
    findings: findings.map((finding) => {
      const ruleCode = /^[A-Z0-9_-]{1,80}$/.test(finding.ruleCode) ? finding.ruleCode : "UNKNOWN";
      return {
        ruleCode,
        ruleTitle: Object.hasOwn(RULE_TITLES, ruleCode) ? RULE_TITLES[ruleCode] : UNKNOWN_RULE_TITLE,
        severity: finding.severity,
        occurrences: finding.occurrences,
      };
    }),
  };
}

// Prepares the decoded model answer for schema validation by the route.
export function reviewAggregatedAnswer(decoded: unknown): unknown {
  if (!decoded || typeof decoded !== "object" || !Array.isArray((decoded as { priorities?: unknown }).priorities)) return decoded;
  const review = decoded as { priorities: unknown[] };
  // The 6-priority limit is enforced here rather than in the schema sent to Groq.
  review.priorities = review.priorities.slice(0, MAX_PRIORITIES);
  return review;
}

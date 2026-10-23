import type { AuditFinding, LedgerEntry } from '@/hooks/use-audit';

type FindingStatus = Record<string, AuditFinding['status']>;

const roundingTolerance = 0.01;
const cashAccountPrefix = '5161';
const taxPenaltyAccountPrefix = '6583';
const cashPaymentThresholdMad = 5_000;
const nearDuplicateWindowDays = 3;
const defaultRecoverableVatRates = [20, 14, 10, 7];
const amount = (entry: LedgerEntry) => entry.debit + entry.credit;
const naturalBalance = (entry: LedgerEntry) => entry.debit - entry.credit;
const accountDigits = (accountCode: string) => accountCode.replace(/\D/g, '');
function addToGroup<T>(groups: Map<string, T[]>, key: string, value: T): void {
  const group = groups.get(key);
  if (group) group.push(value);
  else groups.set(key, [value]);
}

function isValidDate(value: string): boolean {
  const text = value.trim();
  if (!text) return false;
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  const local = /^(\d{1,2})[/. -](\d{1,2})[/. -](\d{4})$/.exec(text);
  if (iso) {
    const [, year, month, day] = iso;
    const date = new Date(Number(year), Number(month) - 1, Number(day));
    return date.getFullYear() === Number(year) &&
      date.getMonth() === Number(month) - 1 &&
      date.getDate() === Number(day);
  }
  if (local) {
    const [, day, month, year] = local;
    const date = new Date(Number(year), Number(month) - 1, Number(day));
    return date.getFullYear() === Number(year) &&
      date.getMonth() === Number(month) - 1 &&
      date.getDate() === Number(day);
  }
  return false;
}

function dateOrdinal(value: string): number | null {
  const text = value.trim();
  if (!isValidDate(text)) return null;
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  const local = /^(\d{1,2})[/. -](\d{1,2})[/. -](\d{4})$/.exec(text);
  if (iso) {
    const [, year, month, day] = iso;
    return Math.floor(Date.UTC(Number(year), Number(month) - 1, Number(day)) / 86_400_000);
  }
  if (local) {
    const [, day, month, year] = local;
    return Math.floor(Date.UTC(Number(year), Number(month) - 1, Number(day)) / 86_400_000);
  }
  return null;
}

function yearFromDate(value: string): number | null {
  if (!isValidDate(value)) return null;
  const parts = value.match(/\d+/g) || [];
  return value.startsWith(parts[0] || '') && parts[0]?.length === 4
    ? Number(parts[0])
    : Number(parts[2]);
}

export function findingId(ruleCode: string, sourceRows: LedgerEntry[]): string {
  // Stable compact fingerprint: an aggregate rule can reference dozens of lines.
  // Keep the persistent ID bounded so PATCH URLs and the tenant DB key stay manageable.
  const input = `${ruleCode}|${sourceRows.map((row) => row.id).sort().join('|')}`;
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193) >>> 0;
    second = Math.imul(second ^ (code + index), 0x85ebca6b) >>> 0;
  }
  return `${ruleCode}-${first.toString(16).padStart(8, '0')}${second.toString(16).padStart(8, '0')}`;
}

export function runAudit(
  entries: LedgerEntry[],
  options: {
    documentType: string;
    fiscalYear: number;
    vatRates: number[];
    vatCollectedPrefixes: string[];
    vatRecoverablePrefixes: string[];
  },
  statusByFinding: FindingStatus,
): AuditFinding[] {
  if (!entries.length) return [];
  const findings: AuditFinding[] = [];
  const push = (
    ruleCode: string,
    severity: AuditFinding['severity'],
    title: string,
    explanation: string,
    sourceRows: LedgerEntry[],
    findingAmount: number,
    suggestion: string,
    // Rows fingerprinted into the ID when they differ from sourceRows, so saved statuses survive a wider context.
    idRows: LedgerEntry[] = sourceRows,
  ) => {
    const id = findingId(ruleCode, idRows);
    findings.push({
      id,
      ruleCode,
      severity,
      title,
      explanation,
      sourceRowIds: sourceRows.map((row) => row.id),
      amount: Number.isFinite(findingAmount) ? Math.abs(findingAmount) : 0,
      suggestion,
      status: statusByFinding[id] || 'open',
    });
  };

  for (const row of entries) {
    const account = accountDigits(row.accountCode);
    if (row.amountParseError) {
      push(
        'ECR-07',
        'high',
        'Montant non interprétable',
        `Le débit ou le crédit en ligne ${row.sourceRow} n’a pas pu être lu comme un montant. La valeur n’est pas incluse dans les totaux.`,
        [row],
        0,
        'Vérifier séparateurs décimaux, séparateurs de milliers et caractères monétaires dans le fichier source.',
      );
    }
    if (row.debit > 0 && row.credit > 0) {
      push(
        'ECR-02',
        'medium',
        'Débit et crédit sur la même ligne',
        `La ligne ${row.sourceRow} porte simultanément un débit de ${row.debit.toFixed(2)} et un crédit de ${row.credit.toFixed(2)} MAD.`,
        [row],
        Math.min(row.debit, row.credit),
        'Vérifier la ventilation ou la saisie d’origine ; aucune modification n’est appliquée.',
      );
    }
    if (row.debit < -roundingTolerance || row.credit < -roundingTolerance) {
      push(
        'ECR-08',
        'medium',
        'Montant négatif dans une colonne de sens',
        `La ligne ${row.sourceRow} contient un montant négatif. Les signes ont été conservés et ne sont pas inversés automatiquement.`,
        [row],
        Math.abs(Math.min(row.debit, row.credit)),
        'Confirmer si le signe représente une extourne ou une convention d’export avant toute correction.',
      );
    }
    if (!row.accountCode.trim() && !row.accountLabel.trim()) {
      push(
        'ECR-03',
        'high',
        'Compte non renseigné',
        `La ligne ${row.sourceRow} ne contient ni code ni libellé de compte.`,
        [row],
        amount(row),
        'Renseigner le compte après vérification de la pièce justificative.',
      );
    }
    if (options.documentType !== 'balance' && !isValidDate(row.date)) {
      push(
        'ECR-04',
        'medium',
        row.date.trim() ? 'Date à contrôler' : 'Date absente',
        row.date.trim()
          ? `La valeur « ${row.date} » en ligne ${row.sourceRow} ne correspond pas aux formats pris en charge (AAAA-MM-JJ ou JJ/MM/AAAA).`
          : `La ligne ${row.sourceRow} ne contient pas de date exploitable.`,
        [row],
        amount(row),
        'Confirmer la date dans la pièce source puis corriger le fichier avant validation.',
      );
    }
    if (!row.reference.trim() && amount(row) > 0 && options.documentType === 'journal') {
      push(
        'ECR-06',
        'low',
        'Référence de pièce absente',
        `La ligne ${row.sourceRow} n’a pas de référence de pièce. Le rapprochement par document est limité.`,
        [row],
        amount(row),
        'Vérifier si la référence est disponible dans le journal source.',
      );
    }
    if (account.startsWith(taxPenaltyAccountPrefix)) {
      push(
        'FISC-02',
        'high',
        'Pénalités ou amendes fiscales détectées',
        `Pénalités ou amendes fiscales enregistrées au compte ${row.accountCode.trim()} — Réintégration extra-comptable obligatoire au Tableau 9 de la Liasse Fiscale (IS).`,
        [row],
        amount(row),
        'Vérifier la nature de la charge et le traitement extra-comptable applicable à l’exercice avec le responsable fiscal.',
      );
    }
    const journalCode = row.journal.trim().toUpperCase();
    const isTemporaryAccount =
      account.startsWith('3491') || account.startsWith('4497');
    const isTreasuryJournal =
      journalCode.startsWith('BQ') || journalCode.startsWith('CS');
    if (
      isTemporaryAccount &&
      isTreasuryJournal &&
      row.debit > roundingTolerance &&
      !row.reference.trim()
    ) {
      push(
        'REG-01',
        'medium',
        'À vérifier — décaissement sur compte temporaire',
        'Décaissement sur compte temporaire/personnel sans pièce justificative d’achat. La référence de pièce est absente de l’import ; Mizan ne peut pas confirmer l’absence d’un justificatif externe.',
        [row],
        row.debit,
        'Rattacher et vérifier le justificatif d’achat, puis confirmer le classement du compte 3491/4497.',
      );
    }
    if (
      options.documentType !== 'balance' &&
      isValidDate(row.date) &&
      yearFromDate(row.date) !== options.fiscalYear
    ) {
      push(
        'PER-01',
        'low',
        'Date hors exercice sélectionné',
        `La ligne ${row.sourceRow} ne semble pas appartenir à l’exercice ${options.fiscalYear}.`,
        [row],
        amount(row),
        'Vérifier la période du dossier et la date source avant d’exclure ou de reclasser la ligne.',
      );
    }
  }

  const totalDebit = entries.reduce((sum, entry) => sum + entry.debit, 0);
  const totalCredit = entries.reduce((sum, entry) => sum + entry.credit, 0);
  const globalDifference = totalDebit - totalCredit;
  if (Math.abs(globalDifference) > roundingTolerance) {
    push(
      'BAL-01',
      'critical',
      options.documentType === 'balance' ? 'Balance déséquilibrée' : 'Périmètre importé déséquilibré',
      `Les colonnes débit et crédit diffèrent de ${Math.abs(globalDifference).toFixed(2)} MAD (débit ${totalDebit.toFixed(2)} MAD, crédit ${totalCredit.toFixed(2)} MAD). Un périmètre partiel peut aussi expliquer cet écart.`,
      entries.slice(0, Math.min(entries.length, 50)),
      globalDifference,
      'Vérifier le périmètre et rechercher des lignes manquantes ou mal associées ; ne pas passer d’écriture automatique.',
    );
  }

  const accountGroups = new Map<string, LedgerEntry[]>();
  for (const row of entries) {
    const key = row.accountCode.trim();
    if (key) addToGroup(accountGroups, key, row);
  }
  for (const [accountCode, rows] of accountGroups) {
    const digits = accountDigits(accountCode);
    const firstDigit = digits[0];
    const balance = rows.reduce((sum, row) => sum + naturalBalance(row), 0);
    const supplierAccount = digits.startsWith('4411');
    const customerAccount = digits.startsWith('3421');

    if (
      (supplierAccount && balance > roundingTolerance) ||
      (customerAccount && balance < -roundingTolerance)
    ) {
      push(
        'BAL-02',
        'high',
        'Solde inversé sur compte de tiers',
        `Solde inversé sur compte de tiers ${accountCode} — Nécessite un reclassement d'inventaire (Avances et acomptes).`,
        rows.slice(0, 50),
        balance,
        'Examiner le grand livre auxiliaire et les règlements ; valider le reclassement d’inventaire avec le responsable comptable.',
      );
    }

    if (digits.startsWith(cashAccountPrefix)) {
      const allDatesValid = rows.every((row) => dateOrdinal(row.date) !== null);
      const orderedRows = [...rows].sort((left, right) => {
        if (allDatesValid) {
          return (dateOrdinal(left.date) ?? 0) - (dateOrdinal(right.date) ?? 0) ||
            left.sourceRow - right.sourceRow;
        }
        return left.sourceRow - right.sourceRow;
      });
      let runningBalance = 0;
      let lowestBalance = options.documentType === 'balance' ? balance : 0;
      let lowestIndex = -1;
      for (let index = 0; index < orderedRows.length; index += 1) {
        runningBalance += naturalBalance(orderedRows[index]);
        if (runningBalance < lowestBalance) {
          lowestBalance = runningBalance;
          lowestIndex = index;
        }
      }
      if (lowestBalance < -roundingTolerance) {
        const sourceRows = lowestIndex < 0
          ? rows.slice(0, 50)
          : orderedRows.slice(Math.max(0, lowestIndex - 49), lowestIndex + 1);
        const dateAtLowestBalance = lowestIndex < 0
          ? ''
          : orderedRows[lowestIndex].date.trim();
        const dateText = dateAtLowestBalance
          ? ` à la date du ${dateAtLowestBalance}`
          : '';
        push(
          'BAL-03',
          'critical',
          'Caisse créditrice',
          `Caisse créditrice détectée (Solde: ${Math.abs(lowestBalance).toFixed(2)} MAD)${dateText} — Irrégularité matérielle grave et risque de redressement fiscal.`,
          sourceRows,
          lowestBalance,
          'Rapprocher immédiatement le compte avec le livre de caisse, les pièces et les mouvements de trésorerie ; confirmer toute anomalie avant correction.',
        );
      }
    }

    const normallyCredit = ['1', '4', '7'].includes(firstDigit || '');
    const normallyDebit = ['2', '3', '6'].includes(firstDigit || '');
    const reversed =
      (normallyCredit && balance > roundingTolerance) ||
      (normallyDebit && balance < -roundingTolerance);
    if (reversed && !supplierAccount && !customerAccount) {
      push(
        'CGNC-01',
        'medium',
        'Solde contraire au sens habituel de la classe',
        `Le compte ${accountCode} présente un solde net débiteur/créditeur contraire au sens généralement attendu pour sa classe. Les comptes d’une même classe peuvent toutefois avoir un sens particulier.`,
        rows.slice(0, 50),
        balance,
        'Examiner le détail du compte, les extournes et la nature du solde avant de conclure à une anomalie.',
      );
    }
  }

  const byDocument = new Map<string, LedgerEntry[]>();
  for (const row of entries) {
    const day = dateOrdinal(row.date);
    if (!row.reference.trim() || !row.journal.trim() || day === null) continue;
    const key = `${day}|${row.journal.trim().toUpperCase()}|${row.reference.trim().toUpperCase()}`;
    addToGroup(byDocument, key, row);
  }
  for (const rows of byDocument.values()) {
    if (rows.length < 2) continue;
    const difference = rows.reduce((sum, row) => sum + row.debit - row.credit, 0);
    if (Math.abs(difference) > roundingTolerance) {
      push(
        'ECR-01',
        'high',
        'Pièce potentiellement déséquilibrée',
        `Les ${rows.length} lignes rapprochées par date, journal et référence présentent un écart de ${Math.abs(difference).toFixed(2)} MAD. Vérifiez que l’import contient toutes les lignes de la pièce.`,
        rows.slice(0, 50),
        difference,
        'Comparer au journal et à la pièce justificative ; un écart sur un extrait incomplet n’est pas une preuve d’erreur.',
      );
    }

    const cashCreditRows = rows.filter(
      (row) =>
        accountDigits(row.accountCode).startsWith(cashAccountPrefix) &&
        row.credit > cashPaymentThresholdMad,
    );
    const expenseRows = rows.filter((row) =>
      accountDigits(row.accountCode).startsWith('6'),
    );
    if (cashCreditRows.length && expenseRows.length) {
      const sourceRows = [...new Map(
        [...cashCreditRows, ...expenseRows].map((row) => [row.id, row]),
      ).values()];
      push(
        'FISC-01',
        'high',
        'Dépassement du plafond de paiement en espèces',
        'Dépassement du plafond légal de paiement en espèces (5 000 MAD TTC) — Risque de non-déductibilité fiscale IS/TVA (Art. 193 du CGI Maroc).',
        sourceRows.slice(0, 50),
        cashCreditRows.reduce((sum, row) => sum + row.credit, 0),
        'Vérifier le montant TTC, le mode de règlement et la règle applicable à l’exercice avec un professionnel fiscal avant toute réintégration.',
      );
    }

    const chargeRows = rows.filter(
      (row) =>
        accountDigits(row.accountCode).startsWith('6') &&
        row.debit > row.credit,
    );
    const recoverableVatRows = rows.filter((row) =>
      accountDigits(row.accountCode).startsWith('3455'),
    );
    const chargeBase = chargeRows.reduce(
      (sum, row) => sum + Math.max(0, row.debit - row.credit),
      0,
    );
    const recordedRecoverableVat = recoverableVatRows.reduce(
      (sum, row) => sum + Math.max(0, row.debit - row.credit),
      0,
    );
    if (chargeBase > roundingTolerance && recordedRecoverableVat > roundingTolerance) {
      const reference = rows[0].reference.trim() || 'sans référence';
      const observedRate = (recordedRecoverableVat / chargeBase) * 100;
      const configuredRates = options.vatRates.filter(
        (rate) => Number.isFinite(rate) && rate > 0 && rate <= 100,
      );
      const referenceRates = configuredRates.length
        ? configuredRates
        : defaultRecoverableVatRates;
      const closestRate = referenceRates.reduce((closest, rate) =>
        Math.abs(rate - observedRate) < Math.abs(closest - observedRate)
          ? rate
          : closest,
      );
      const gapInPoints = Math.abs(observedRate - closestRate);
      if (gapInPoints > 2) {
        const rateRows = [...new Map(
          [...chargeRows, ...recoverableVatRows].map((row) => [row.id, row]),
        ).values()];
        // The whole document is shown and sent to the AI correction, so the supplier counterpart is known;
        // charge and VAT lines come first so the 50-row limit never cuts them.
        const sourceRows = [...new Map(
          [...rateRows, ...rows].map((row) => [row.id, row]),
        ).values()];
        push(
          'FISC-03',
          'high',
          'Incohérence du taux de TVA récupérable',
          `Incohérence détectée sur le taux de TVA récupérable calculé sur la pièce ${reference}. Taux reconstitué : ${observedRate.toFixed(2)} % ; écart : ${gapInPoints.toFixed(2)} points par rapport au taux de référence le plus proche (${closestRate} %).`,
          sourceRows.slice(0, 50),
          recordedRecoverableVat - (chargeBase * closestRate / 100),
          'Comparer la base, la TVA portée au compte 3455 et la facture ; confirmer le taux légal applicable à l’exercice avant toute correction.',
          rateRows.slice(0, 50),
        );
      }
    }
  }

  const duplicateGroups = new Map<string, LedgerEntry[]>();
  for (const row of entries) {
    if (
      !row.reference.trim() ||
      !row.accountCode.trim() ||
      Math.abs(row.debit) + Math.abs(row.credit) <= roundingTolerance
    ) continue;
    const key = [
      row.accountCode.trim().toLowerCase(),
      row.reference.trim().toLowerCase(),
      row.debit,
      row.credit,
    ].join('|');
    addToGroup(duplicateGroups, key, row);
  }
  for (const groupedRows of duplicateGroups.values()) {
    const datedRows = groupedRows
      .map((row) => ({ row, day: dateOrdinal(row.date) }))
      .filter((item): item is { row: LedgerEntry; day: number } => item.day !== null)
      .sort((left, right) => left.day - right.day || left.row.sourceRow - right.row.sourceRow);
    let cluster: LedgerEntry[] = [];
    let clusterStartDay: number | null = null;
    const reportCluster = () => {
      if (cluster.length > 1) {
        const example = cluster[0];
        const duplicatedAmount = Math.abs(example.debit) + Math.abs(example.credit);
        push(
          'DUP-01',
          'high',
          'Risque de double comptabilisation',
          `Risque de double comptabilisation / doublon de pièce ${example.reference.trim()} pour un montant de ${duplicatedAmount.toFixed(2)} MAD. Les dates sont identiques ou séparées de 1 à ${nearDuplicateWindowDays} jours.`,
          cluster.slice(0, 50),
          duplicatedAmount,
          'Comparer les pièces originales et les dates de comptabilisation avant de confirmer ou corriger un doublon.',
        );
      }
    };
    for (const item of datedRows) {
      if (
        clusterStartDay === null ||
        item.day - clusterStartDay > nearDuplicateWindowDays
      ) {
        reportCluster();
        cluster = [item.row];
        clusterStartDay = item.day;
      } else {
        cluster.push(item.row);
      }
    }
    reportCluster();
  }

  const collected = options.vatCollectedPrefixes.filter(Boolean);
  const recoverable = options.vatRecoverablePrefixes.filter(Boolean);
  if (options.vatRates.length && (collected.length || recoverable.length)) {
    for (const rows of byDocument.values()) {
      if (rows.some((row) => accountDigits(row.accountCode).startsWith('3455'))) {
        continue;
      }
      const base = rows.reduce((sum, row) => {
        const accountClass = row.accountCode.trim()[0];
        if (accountClass === '6') return sum + Math.max(0, row.debit - row.credit);
        if (accountClass === '7') return sum + Math.max(0, row.credit - row.debit);
        return sum;
      }, 0);
      if (base <= 0) continue;
      const tax = rows.reduce((sum, row) => {
        const account = row.accountCode.trim();
        if (collected.some((prefix) => account.startsWith(prefix))) {
          return sum + Math.max(0, row.credit - row.debit);
        }
        if (recoverable.some((prefix) => account.startsWith(prefix))) {
          return sum + Math.max(0, row.debit - row.credit);
        }
        return sum;
      }, 0);
      if (tax <= 0) continue;
      const observedRate = (tax / base) * 100;
      const configuredMatch = options.vatRates.some(
        (rate) => Math.abs(rate - observedRate) <= 0.5,
      );
      if (!configuredMatch) {
        push(
          'TVA-01',
          'medium',
          'Taux de TVA reconstitué à vérifier',
          `Pour cette pièce, le rapport TVA/base est d’environ ${observedRate.toFixed(2)} %. Il ne correspond pas aux taux indicatifs configurés. Vérifiez le paramétrage des comptes, les bases et la période ; plusieurs taux sur une pièce peuvent expliquer l’écart.`,
          rows.slice(0, 50),
          tax,
          'Comparer la pièce et le paramétrage fiscal applicable à l’exercice. Ce contrôle ne certifie pas le taux légal.',
        );
      }
    }
  }

  return findings;
}

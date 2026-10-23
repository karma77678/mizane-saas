import type { ColumnMap } from '@/hooks/use-audit';

export function guessColumnMap(headers: string[]): ColumnMap {
  const map: ColumnMap = {
    date: '',
    journal: '',
    accountCode: '',
    accountLabel: '',
    reference: '',
    description: '',
    debit: '',
    credit: '',
  };
  const normalize = (value: string) => value
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-z0-9\u0600-\u06FF]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
  const aliases: Record<keyof ColumnMap, string[]> = {
    date: ['date', 'date piece', 'date comptable', 'تاريخ'],
    journal: ['journal', 'code journal', 'دفتر'],
    accountLabel: [
      'libelle compte',
      'libelle du compte',
      'intitule compte',
      'intitule du compte',
      'account label',
      'account name',
      'اسم الحساب',
    ],
    accountCode: ['code compte', 'numero compte', 'num compte', 'account code', 'compte', 'حساب'],
    reference: ['reference', 'ref', 'numero piece', 'num piece', 'n piece', 'no piece', 'piece', 'مرجع'],
    description: ['description', 'libelle operation', 'libelle ecriture', 'libelle', 'بيان'],
    debit: ['debit', 'montant debit', 'مدين'],
    credit: ['credit', 'montant credit', 'دائن'],
  };
  const priority: (keyof ColumnMap)[] = [
    'date',
    'journal',
    'accountLabel',
    'accountCode',
    'reference',
    'debit',
    'credit',
    'description',
  ];
  const normalizedHeaders = headers.map(normalize);
  const used = new Set<number>();
  for (const key of priority) {
    const normalizedAliases = aliases[key].map(normalize);
    const index = normalizedHeaders.findIndex((header, candidate) =>
      !used.has(candidate) &&
      normalizedAliases.some((alias) =>
        header === alias ||
        header.startsWith(`${alias} `) ||
        header.endsWith(` ${alias}`) ||
        header.includes(` ${alias} `),
      ),
    );
    if (index >= 0) {
      map[key] = String(index);
      used.add(index);
    }
  }
  return map;
}

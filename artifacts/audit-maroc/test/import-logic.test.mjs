/**
 * Unit tests for the pure logic on the import path: amount parsing and
 * automatic column detection. No database, no browser, no React.
 *
 *   node --test artifacts/audit-maroc/test/import-logic.test.mjs
 *
 * These two functions decide what actually lands in PostgreSQL. A wrong
 * thousands/decimal guess silently changes every total and every finding, and
 * a wrong header guess makes the confirm button reject a perfectly good file.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseAmount } from "../src/lib/parse-amount.ts";
import { guessColumnMap } from "../src/lib/column-mapping.ts";

describe("parseAmount", () => {
  it("reads an empty cell as zero, not as an error", () => {
    for (const blank of ["", "   ", "\t"]) {
      assert.deepEqual(parseAmount(blank), { value: 0, invalid: false });
    }
  });

  it("reads plain integers and simple decimals", () => {
    assert.equal(parseAmount("0").value, 0);
    assert.equal(parseAmount("42").value, 42);
    assert.equal(parseAmount("1234").value, 1234);
    assert.equal(parseAmount("12.34").value, 12.34);
    assert.equal(parseAmount("12,34").value, 12.34);
  });

  it("reads the French/Moroccan convention: comma decimal, space thousands", () => {
    assert.equal(parseAmount("1 234,56").value, 1234.56);
    // Non-breaking and narrow no-break spaces, as produced by Excel exports.
    assert.equal(parseAmount("1 234,56").value, 1234.56);
    assert.equal(parseAmount("1 234,56").value, 1234.56);
    assert.equal(parseAmount("1.234,56").value, 1234.56);
    assert.equal(parseAmount("1'234,56").value, 1234.56);
  });

  it("reads the Anglo convention: dot decimal, comma thousands", () => {
    assert.equal(parseAmount("1,234.56").value, 1234.56);
    assert.equal(parseAmount("1,234,567.89").value, 1234567.89);
  });

  it("treats exactly three trailing digits after a single separator as thousands", () => {
    // The ambiguous case that matters most in ledgers.
    assert.equal(parseAmount("1.234").value, 1234);
    assert.equal(parseAmount("1,234").value, 1234);
    assert.equal(parseAmount("12.345").value, 12345);
    // Not three digits -> it is a decimal mark.
    assert.equal(parseAmount("1.2").value, 1.2);
    assert.equal(parseAmount("1.23").value, 1.23);
    assert.equal(parseAmount("1.2345").value, 1.2345);
  });

  it("reads several thousands separators", () => {
    assert.equal(parseAmount("1.234.567").value, 1234567);
    assert.equal(parseAmount("1 234 567").value, 1234567);
    assert.equal(parseAmount("1.234.567,89").value, 1234567.89);
  });

  it("reads negatives, including the accounting parenthesis form", () => {
    assert.equal(parseAmount("-1 234,56").value, -1234.56);
    assert.equal(parseAmount("(1 234,56)").value, -1234.56);
    assert.equal(parseAmount("(1234)").value, -1234);
    assert.equal(parseAmount("1 234,56-").value, -1234.56);
    assert.equal(parseAmount("+1 234,56").value, 1234.56);
  });

  it("ignores a currency suffix or prefix", () => {
    assert.equal(parseAmount("1 234,56 MAD").value, 1234.56);
    assert.equal(parseAmount("1 234,56 DH").value, 1234.56);
    assert.equal(parseAmount("MAD 1 234,56").value, 1234.56);
  });

  it("flags a non-numeric cell instead of silently returning zero", () => {
    // Treating these as 0 would hide a broken column mapping and distort
    // every total; the import flags the row instead.
    for (const junk of ["N/A", "—", "néant", "---", "?"]) {
      const result = parseAmount(junk);
      assert.equal(result.invalid, true, `${junk} should be flagged as invalid`);
      assert.equal(result.value, 0);
    }
  });

  it("never returns NaN or Infinity", () => {
    for (const input of ["", "abc", "1,2,3", "...", ",,,", "1e999", "-", "()"]) {
      const result = parseAmount(input);
      assert.ok(Number.isFinite(result.value), `${JSON.stringify(input)} produced ${result.value}`);
    }
  });
});

describe("guessColumnMap", () => {
  it("maps a typical French ledger header row", () => {
    const map = guessColumnMap(["Date", "Journal", "Compte", "Libellé", "Pièce", "Désignation", "Débit", "Crédit"]);
    assert.equal(map.date, "0");
    assert.equal(map.journal, "1");
    assert.equal(map.accountCode, "2");
    assert.equal(map.debit, "6");
    assert.equal(map.credit, "7");
  });

  it("finds debit and credit regardless of case and accents", () => {
    const map = guessColumnMap(["DATE", "N° COMPTE", "DEBIT MAD", "CREDIT MAD"]);
    assert.equal(map.debit, "2");
    assert.equal(map.credit, "3");
    assert.notEqual(map.date, "");
  });

  it("returns empty strings for columns it cannot identify", () => {
    const map = guessColumnMap(["col1", "col2", "col3"]);
    for (const value of Object.values(map)) {
      assert.equal(typeof value, "string");
    }
    // Unmapped must be '' — the import flow uses that to require a manual
    // choice rather than guessing.
    assert.equal(map.debit, "");
    assert.equal(map.credit, "");
  });

  it("always returns every key of the column map", () => {
    const map = guessColumnMap([]);
    assert.deepEqual(
      Object.keys(map).sort(),
      ["accountCode", "accountLabel", "credit", "date", "debit", "description", "journal", "reference"],
    );
  });

  it("never points at a column index that does not exist", () => {
    const headers = ["Date", "Débit", "Crédit"];
    const map = guessColumnMap(headers);
    for (const [key, value] of Object.entries(map)) {
      if (value === "") continue;
      const index = Number(value);
      assert.ok(
        Number.isInteger(index) && index >= 0 && index < headers.length,
        `${key} -> ${value} is out of range`,
      );
    }
  });
});

import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  doublePrecision,
} from "drizzle-orm/pg-core";

export const userRoleEnum = pgEnum("user_role", ["admin", "auditeur", "client"]);
export const constatStatusEnum = pgEnum("constat_status", ["A_EXAMINER", "VERIFIE", "ECARTE"]);

export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  role: userRoleEnum("role").notNull().default("auditeur"),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const workspaces = pgTable("workspaces", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const workspaceMembers = pgTable("workspace_members", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  role: userRoleEnum("role").notNull().default("auditeur"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("workspace_members_workspace_user_unique").on(table.workspaceId, table.userId),
  index("workspace_members_user_idx").on(table.userId),
]);

export const dossiers = pgTable("dossiers", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  clientName: text("client_name").notNull(),
  exerciceAnnee: integer("exercice_annee").notNull(),
  status: text("status").notNull().default("OUVERT"),
  settingsJson: jsonb("settings_json"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index("dossiers_workspace_idx").on(table.workspaceId)]);

export const imports = pgTable("imports", {
  id: uuid("id").defaultRandom().primaryKey(),
  dossierId: uuid("dossier_id").notNull().references(() => dossiers.id, { onDelete: "cascade" }),
  fileName: text("file_name").notNull(),
  fileDataJson: jsonb("file_data_json").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index("imports_dossier_idx").on(table.dossierId)]);

export const constats = pgTable("constats", {
  id: text("id").primaryKey(),
  importId: uuid("import_id").notNull().references(() => imports.id, { onDelete: "cascade" }),
  ruleCode: text("rule_code").notNull(),
  severity: text("severity").notNull(),
  amount: doublePrecision("amount").notNull().default(0),
  explanation: text("explanation").notNull(),
  cellReference: text("cell_reference").notNull().default(""),
  status: constatStatusEnum("status").notNull().default("A_EXAMINER"),
  proposedCorrection: jsonb("proposed_correction"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("constats_import_idx").on(table.importId),
  index("constats_status_idx").on(table.status),
]);

export const sessions = pgTable("sessions", {
  tokenHash: text("token_hash").primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index("sessions_user_idx").on(table.userId), index("sessions_expiry_idx").on(table.expiresAt)]);

export type User = typeof users.$inferSelect;
export type Workspace = typeof workspaces.$inferSelect;
export type Dossier = typeof dossiers.$inferSelect;
export type ImportRecord = typeof imports.$inferSelect;
export type Constat = typeof constats.$inferSelect;

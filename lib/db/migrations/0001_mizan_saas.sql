-- Mizan SaaS foundation: PostgreSQL persistence, authentication sessions and tenant isolation.
CREATE TYPE user_role AS ENUM ('admin', 'auditeur', 'client');
CREATE TYPE constat_status AS ENUM ('A_EXAMINER', 'VERIFIE', 'ECARTE');

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  role user_role NOT NULL DEFAULT 'auditeur',
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE workspace_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role user_role NOT NULL DEFAULT 'auditeur',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX workspace_members_workspace_user_unique ON workspace_members(workspace_id, user_id);
CREATE INDEX workspace_members_user_idx ON workspace_members(user_id);

CREATE TABLE dossiers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  client_name text NOT NULL,
  exercice_annee integer NOT NULL,
  status text NOT NULL DEFAULT 'OUVERT',
  settings_json jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX dossiers_workspace_idx ON dossiers(workspace_id);

CREATE TABLE imports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dossier_id uuid NOT NULL REFERENCES dossiers(id) ON DELETE CASCADE,
  file_name text NOT NULL,
  file_data_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX imports_dossier_idx ON imports(dossier_id);

CREATE TABLE constats (
  id text PRIMARY KEY,
  import_id uuid NOT NULL REFERENCES imports(id) ON DELETE CASCADE,
  rule_code text NOT NULL,
  severity text NOT NULL,
  amount double precision NOT NULL DEFAULT 0,
  explanation text NOT NULL,
  cell_reference text NOT NULL DEFAULT '',
  status constat_status NOT NULL DEFAULT 'A_EXAMINER',
  proposed_correction jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX constats_import_idx ON constats(import_id);
CREATE INDEX constats_status_idx ON constats(status);

CREATE TABLE sessions (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_idx ON sessions(user_id);
CREATE INDEX sessions_expiry_idx ON sessions(expires_at);

-- ═══════════════════════════════════════════════════════════════
-- Morpheus v2.0 — Full Supabase Schema
-- Run this in Supabase → SQL Editor → Run
-- ═══════════════════════════════════════════════════════════════

-- ── Ventures — business contexts ────────────────────────────────────
CREATE TABLE IF NOT EXISTS ventures (
  id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  name        text NOT NULL,
  display     text,
  description text,
  owner_phone text NOT NULL,
  created_at  timestamptz DEFAULT now(),
  updated_at  timestamptz DEFAULT now()
);

-- ── Projects — one per build job ────────────────────────────────────
CREATE TABLE IF NOT EXISTS projects (
  id           uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  job_id       text UNIQUE NOT NULL,
  venture_id   uuid REFERENCES ventures(id) ON DELETE SET NULL,
  phone        text NOT NULL,
  prompt       text,
  status       text NOT NULL DEFAULT 'running',
  iterations   integer DEFAULT 0,
  output_url   text,
  repo_url     text,
  created_at   timestamptz DEFAULT now(),
  updated_at   timestamptz DEFAULT now(),
  completed_at timestamptz
);

-- ── Memories — long-term knowledge per venture ───────────────────────
CREATE TABLE IF NOT EXISTS memories (
  id                uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  venture_id        uuid REFERENCES ventures(id) ON DELETE CASCADE,
  source_project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
  type              text NOT NULL DEFAULT 'technical',
  title             text NOT NULL,
  content           text NOT NULL,
  importance        integer DEFAULT 7,
  created_at        timestamptz DEFAULT now(),
  updated_at        timestamptz DEFAULT now()
);

-- ── The Matrix — live self-updating master plan ──────────────────────
CREATE TABLE IF NOT EXISTS matrix_phases (
  id           uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  phase_number integer UNIQUE NOT NULL,
  title        text NOT NULL,
  description  text,
  sort_order   integer DEFAULT 0,
  created_at   timestamptz DEFAULT now(),
  updated_at   timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS matrix_items (
  id                uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  phase_id          uuid REFERENCES matrix_phases(id) ON DELETE CASCADE,
  phase_number      integer NOT NULL,
  label             text NOT NULL,
  status            text NOT NULL DEFAULT 'future',  -- done|todo|bug|future
  note              text,
  sort_order        integer DEFAULT 0,
  related_job_id    text,
  related_task_type text,
  completed_at      timestamptz,
  updated_at        timestamptz DEFAULT now(),
  created_at        timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS matrix_changelog (
  id             uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  item_id        uuid REFERENCES matrix_items(id) ON DELETE CASCADE,
  phase_number   integer,
  label          text,
  old_status     text,
  new_status     text,
  changed_by     text DEFAULT 'morpheus',
  related_job_id text,
  note           text,
  created_at     timestamptz DEFAULT now()
);

-- ── Indexes ──────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_projects_phone      ON projects(phone);
CREATE INDEX IF NOT EXISTS idx_projects_job_id     ON projects(job_id);
CREATE INDEX IF NOT EXISTS idx_projects_status     ON projects(status);
CREATE INDEX IF NOT EXISTS idx_memories_venture    ON memories(venture_id);
CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(importance DESC);
CREATE INDEX IF NOT EXISTS idx_matrix_items_phase  ON matrix_items(phase_number);
CREATE INDEX IF NOT EXISTS idx_matrix_items_status ON matrix_items(status);
CREATE INDEX IF NOT EXISTS idx_matrix_changelog    ON matrix_changelog(created_at DESC);

-- ── Auto-update timestamps ───────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ventures_updated_at    BEFORE UPDATE ON ventures    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER projects_updated_at    BEFORE UPDATE ON projects    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER memories_updated_at    BEFORE UPDATE ON memories    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER matrix_items_updated_at BEFORE UPDATE ON matrix_items FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ── Row Level Security — public read for Matrix, service write ───────
ALTER TABLE matrix_phases    ENABLE ROW LEVEL SECURITY;
ALTER TABLE matrix_items     ENABLE ROW LEVEL SECURITY;
ALTER TABLE matrix_changelog ENABLE ROW LEVEL SECURITY;

CREATE POLICY "public read matrix_phases"    ON matrix_phases    FOR SELECT USING (true);
CREATE POLICY "public read matrix_items"     ON matrix_items     FOR SELECT USING (true);
CREATE POLICY "public read matrix_changelog" ON matrix_changelog FOR SELECT USING (true);

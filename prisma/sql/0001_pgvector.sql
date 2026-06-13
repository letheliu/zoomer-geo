CREATE EXTENSION IF NOT EXISTS vector;

CREATE INDEX IF NOT EXISTS idx_citation_query_embedding
  ON "CitationQuery" USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

CREATE INDEX IF NOT EXISTS idx_citation_event_embedding
  ON "CitationEvent" USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

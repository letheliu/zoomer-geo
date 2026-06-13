export interface CitationEntry {
  url: string
  position: number
  snippet?: string
}

export interface PlatformResult {
  answer: string
  citations: CitationEntry[]
  mentionedBrands: string[]
}

export interface PlatformAdapter {
  name: string
  query(text: string, credentials: Record<string, string>): Promise<PlatformResult>
}

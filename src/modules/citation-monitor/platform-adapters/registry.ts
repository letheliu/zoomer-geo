import type { PlatformAdapter } from './types.js'

export interface AdapterRegistry {
  register(adapter: PlatformAdapter): void
  get(name: string): PlatformAdapter | undefined
  list(): string[]
}

export function createAdapterRegistry(): AdapterRegistry {
  const adapters = new Map<string, PlatformAdapter>()
  return {
    register(adapter) {
      adapters.set(adapter.name, adapter)
    },
    get(name) {
      return adapters.get(name)
    },
    list() {
      return Array.from(adapters.keys())
    },
  }
}

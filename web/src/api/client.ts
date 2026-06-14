import { createTRPCProxyClient, httpBatchLink } from '@trpc/client'
import type { GeoAppRouter } from '@scope/geo-sdk'

let currentApiKey = ''

export function setApiKey(key: string) {
  currentApiKey = key
}

export const trpc = createTRPCProxyClient<GeoAppRouter>({
  links: [
    httpBatchLink({
      url: `${import.meta.env.VITE_GEO_API_URL || ''}/trpc`,
      headers: () => {
        const h: Record<string, string> = {}
        if (currentApiKey) h['x-api-key'] = currentApiKey
        return h
      },
    }),
  ],
})

import { completeSimple } from "@earendil-works/pi-ai/compat"

export interface PiGenerationClient {
  complete: typeof completeSimple
}

export const piGenerationClient: PiGenerationClient = {
  complete: completeSimple,
}

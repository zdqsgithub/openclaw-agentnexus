import {
  loadModelCatalog,
  type ModelCatalogEntry,
  resetModelCatalogCacheForTest,
} from "../agents/model-catalog.js";
import { buildConfiguredModelCatalog } from "../agents/model-selection.js";
import { getRuntimeConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

export type GatewayModelChoice = ModelCatalogEntry;

// Test-only escape hatch: model catalog is cached at module scope for the
// process lifetime, which is fine for the real gateway daemon, but makes
// isolated unit tests harder. Keep this intentionally obscure.
export function __resetModelCatalogCacheForTest() {
  resetModelCatalogCacheForTest();
}

export async function loadGatewayModelCatalog(params?: {
  getConfig?: () => ReturnType<typeof getRuntimeConfig>;
}): Promise<GatewayModelChoice[]> {
  return await loadModelCatalog({ config: (params?.getConfig ?? getRuntimeConfig)() });
}

type GatewayModelCatalogLoader = () => Promise<GatewayModelChoice[]>;

export function resolveGatewayModelCatalogLoader(params: {
  managedHeadlessGateway: boolean;
  getConfig?: () => OpenClawConfig;
  fallback?: GatewayModelCatalogLoader;
}): GatewayModelCatalogLoader {
  const getConfig = params.getConfig ?? getRuntimeConfig;
  const fallback = params.fallback ?? (() => loadGatewayModelCatalog({ getConfig }));
  if (!params.managedHeadlessGateway) {
    return fallback;
  }
  return async () => buildConfiguredModelCatalog({ cfg: getConfig() });
}

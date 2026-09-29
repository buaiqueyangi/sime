import { Injectable, OnModuleInit } from '@nestjs/common';
import { AssetRegistry, LoadResult, registryFromEnv, AssetKind } from './registry';

/** 三类声明式资产（规则/适配器/物模型）的统一注册与校验入口。 */
@Injectable()
export class AssetRegistryService implements OnModuleInit {
  private registry!: AssetRegistry;
  private loaded: Partial<Record<AssetKind, LoadResult>> = {};

  onModuleInit() {
    this.registry = registryFromEnv();
    this.registry.loadAll();
  }

  get(kind: AssetKind): LoadResult {
    if (!this.loaded[kind]) this.loaded[kind] = this.registry.load(kind);
    return this.loaded[kind]!;
  }

  counts(): Record<AssetKind, number> {
    return this.registry.counts();
  }

  errors(): { file: string; error: string }[] {
    return this.registry.totalErrors();
  }
}

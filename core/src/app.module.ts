import { Module } from '@nestjs/common';
import { AssetRegistryService } from './common/asset-registry.service';
import { PgProfileService } from './common/pg-profile.service';
import { HealthController } from './modules/health/health.controller';
import { RulesController } from './modules/rules/rules.controller';
import { AdaptersController } from './modules/adapters/adapters.controller';
import { ThingModelsController } from './modules/thing-model/thing-model.controller';
import { AlertsController } from './modules/alerts/alerts.controller';
import { PipelineController } from './modules/pipeline/pipeline.controller';
import { RuleEngineService } from './rule-engine/rule-engine.service';

@Module({
  controllers: [
    HealthController,
    RulesController,
    AdaptersController,
    ThingModelsController,
    AlertsController,
    PipelineController,
  ],
  providers: [AssetRegistryService, RuleEngineService, PgProfileService],
})
export class AppModule {}

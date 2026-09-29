import { Module } from '@nestjs/common';
import { AssetRegistryService } from './common/asset-registry.service';
import { PgProfileService } from './common/pg-profile.service';
import { HealthController } from './modules/health/health.controller';
import { RulesController } from './modules/rules/rules.controller';
import { AdaptersController } from './modules/adapters/adapters.controller';
import { ThingModelsController } from './modules/thing-model/thing-model.controller';
import { AlertsController } from './modules/alerts/alerts.controller';
import { PipelineController } from './modules/pipeline/pipeline.controller';
import { TelemetryController } from './telemetry/telemetry.controller';
import { TelemetryService } from './telemetry/telemetry.service';
import { MqttIngestService } from './ingest/mqtt-ingest.service';
import { ResponseService } from './response/response.service';
import { RuleEngineService } from './rule-engine/rule-engine.service';

@Module({
  controllers: [
    HealthController,
    RulesController,
    AdaptersController,
    ThingModelsController,
    AlertsController,
    PipelineController,
    TelemetryController,
  ],
  providers: [
    AssetRegistryService,
    RuleEngineService,
    PgProfileService,
    ResponseService,
    TelemetryService,
    MqttIngestService,
  ],
})
export class AppModule {}

import { Module } from '@nestjs/common';
import { AssetRegistryService } from './common/asset-registry.service';
import { PgProfileService } from './common/pg-profile.service';
import { HealthController } from './modules/health/health.controller';
import { RulesController } from './modules/rules/rules.controller';
import { AdaptersController } from './modules/adapters/adapters.controller';
import { ThingModelsController } from './modules/thing-model/thing-model.controller';
import { AlertsController } from './modules/alerts/alerts.controller';
import { PipelineController } from './modules/pipeline/pipeline.controller';
import { ResponsesController } from './modules/responses/responses.controller';
import { TelemetryController } from './telemetry/telemetry.controller';
import { TelemetryService } from './telemetry/telemetry.service';
import { MqttIngestService } from './ingest/mqtt-ingest.service';
import { ResponseService } from './response/response.service';
import { RuleEngineService } from './rule-engine/rule-engine.service';
import { AuthService } from './auth/auth.service';
import { AuthController } from './auth/auth.controller';
import { PlaybooksController } from './modules/playbooks/playbooks.controller';
import { PlaybookService } from './soar/playbook.service';
import { WsService } from './ws/ws.service';
import { NotifyService } from './notify/notify.service';
import { LakeService } from './lake/lake.service';
import { LakeController } from './lake/lake.controller';
import { TopologyService } from './topology/topology.service';
import { TopologyController } from './topology/topology.controller';

@Module({
  controllers: [
    HealthController,
    RulesController,
    AdaptersController,
    ThingModelsController,
    AlertsController,
    PipelineController,
    TelemetryController,
    ResponsesController,
    AuthController,
    PlaybooksController,
    LakeController,
    TopologyController,
  ],
  providers: [
    AssetRegistryService,
    RuleEngineService,
    PgProfileService,
    ResponseService,
    TelemetryService,
    MqttIngestService,
    AuthService,
    PlaybookService,
    WsService,
    NotifyService,
    LakeService,
    TopologyService,
  ],
})
export class AppModule {}

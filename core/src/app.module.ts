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
import { AssistantService } from './assistant/assistant.service';
import { AssistantController } from './assistant/assistant.controller';
import { QueryService } from './query/query.service';
import { QueryController } from './query/query.controller';
import { RetentionService } from './maintenance/retention.service';
import { RetentionController } from './maintenance/retention.controller';
import { ExportService } from './maintenance/export.service';
import { ExportController } from './maintenance/export.controller';
import { EventStoreService } from './ingest/event-store.service';
import { EventsService } from './ingest/events.service';
import { EventsController } from './ingest/events.controller';
import { IngestService } from './ingest/ingest.service';
import { IngestController } from './ingest/ingest.controller';
import { ImportService } from './ingest/import.service';

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
    AssistantController,
    QueryController,
    RetentionController,
    ExportController,
    EventsController,
    IngestController,
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
    AssistantService,
    QueryService,
    RetentionService,
    ExportService,
    EventStoreService,
    EventsService,
    IngestService,
    ImportService,
  ],
})
export class AppModule {}

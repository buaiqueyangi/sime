import 'reflect-metadata';
import cluster from 'node:cluster';
import { WorkerMain } from './worker';

/**
 * 入口分叉（M3 多核分片，蓝图 §6.3 演进版）：
 *   SIME_WORKERS > 1：主进程承载 API/WS/MQTT 接入，按 key 哈希把事件分发到 N 个
 *   worker 子进程（各持独立规则引擎窗口状态与 PG 连接）——同设备事件必落同分片，
 *   聚合窗口正确性不牺牲；分片可横向扩展到多机（接入转发层同构）。
 *   SIME_WORKERS = 1（默认）：单进程路径，行为与历史版本完全一致。
 */
if (cluster.isWorker) {
  const m = new WorkerMain();
  void m.start();
} else {
  void import('./master').then((m) => m.bootstrapMaster());
}

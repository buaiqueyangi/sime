import { Injectable, Logger } from '@nestjs/common';

/**
 * 通知渠道服务（M2 SOAR 实化）：
 *   SIME_NOTIFY_WEBHOOK_URL         通用 webhook（JSON POST）
 *   SIME_NOTIFY_WECOM_WEBHOOK       企业微信群机器人
 *   SIME_NOTIFY_DINGTALK_WEBHOOK    钉钉群机器人
 * 未配置对应渠道时降级为 simulated（仅落库），配置后自动真实发送。
 */
@Injectable()
export class NotifyService {
  private readonly logger = new Logger('Notify');

  channels() {
    return {
      webhook: process.env.SIME_NOTIFY_WEBHOOK_URL ?? null,
      wecom: process.env.SIME_NOTIFY_WECOM_WEBHOOK ?? null,
      dingtalk: process.env.SIME_NOTIFY_DINGTALK_WEBHOOK ?? null,
    };
  }

  /** 按优先级派发到首个已配置渠道；返回实际投递状态。 */
  async dispatch(channel: string, title: string, payload: Record<string, unknown>): Promise<'sent' | 'simulated' | 'failed'> {
    const c = this.channels();
    const text = `**[${channel}]** ${title}\n> ${JSON.stringify(payload).slice(0, 300)}`;
    try {
      if (c.wecom) {
        await this.post(c.wecom, { msgtype: 'markdown', markdown: { content: text } });
        return 'sent';
      }
      if (c.dingtalk) {
        await this.post(c.dingtalk, { msgtype: 'markdown', markdown: { title: channel, text } });
        return 'sent';
      }
      if (c.webhook) {
        await this.post(c.webhook, { channel, title, payload });
        return 'sent';
      }
      return 'simulated';
    } catch (e) {
      this.logger.warn(`notify ${channel} failed: ${e instanceof Error ? e.message : String(e)}`);
      return 'failed';
    }
  }

  private async post(url: string, body: unknown): Promise<void> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 5000);
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
    } finally {
      clearTimeout(timer);
    }
  }
}

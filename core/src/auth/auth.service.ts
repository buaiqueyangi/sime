import { Injectable, UnauthorizedException } from '@nestjs/common';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { envStr } from '../common/env';

/**
 * 认证服务（M1）：HMAC 无状态 token（默认 12h 过期）。
 * secret 未配置时每次启动随机生成（重启即全端下线）；生产建议设置 SIME_AUTH_SECRET。
 * 默认账号 admin / sime123456，用 SIME_ADMIN_PASSWORD 覆盖。
 *
 * 注意：这里必须用 envStr 而不是 `??`——compose/K8s 未填该变量时会注入空串，
 * `?? 默认值` 拦不住空串，会导致"密码默认值被空串覆盖，谁都登不进来"（现网事故）。
 */
export interface AuthUser {
  username: string;
  exp: number;
}

@Injectable()
export class AuthService {
  private readonly secret = envStr('SIME_AUTH_SECRET') ?? randomBytes(32).toString('hex');
  private readonly adminUser = envStr('SIME_ADMIN_USER', 'admin');
  private readonly adminPass = envStr('SIME_ADMIN_PASSWORD', 'sime123456');
  private readonly ttlMs = 12 * 3600 * 1000;

  login(username: string, password: string): { token: string; user: string; expiresIn: number } | null {
    // 先哈希再比较：长度一致且恒定时间，错误长度的输入不会抛异常
    const h = (s: string) => createHash('sha256').update(s).digest();
    const okUser = timingSafeEqual(h(username ?? ''), h(this.adminUser));
    const okPass = timingSafeEqual(h(password ?? ''), h(this.adminPass));
    if (!okUser || !okPass) throw new UnauthorizedException('用户名或密码错误');
    const user: AuthUser = { username: this.adminUser, exp: Date.now() + this.ttlMs };
    const payload = Buffer.from(JSON.stringify(user)).toString('base64url');
    const sig = createHmac('sha256', this.secret).update(payload).digest('base64url');
    return { token: `${payload}.${sig}`, user: this.adminUser, expiresIn: this.ttlMs };
  }

  verify(token: string): AuthUser | null {
    if (!token || !token.includes('.')) return null;
    const [payload, sig] = token.split('.');
    if (!payload || !sig) return null;
    const expect = createHmac('sha256', this.secret).update(payload).digest('base64url');
    const a = Buffer.from(sig);
    const b = Buffer.from(expect);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    try {
      const user = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as AuthUser;
      if (!user.exp || user.exp < Date.now()) return null;
      return user;
    } catch {
      return null;
    }
  }
}

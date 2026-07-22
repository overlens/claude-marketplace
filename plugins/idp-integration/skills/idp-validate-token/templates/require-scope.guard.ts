// src/auth/require-scope.guard.ts
//
// Authorize a SERVICE (M2M) by scope. Use AFTER JwtAuthGuard. A service token
// is authorized by `scope`, NEVER by `role` (it has none). This guard rejects
// user tokens on M2M-only endpoints by requiring kind === 'service'.

import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Principal } from './jwt.strategy';

@Injectable()
export class RequireScope implements CanActivate {
  constructor(private readonly scope: string) {}

  canActivate(ctx: ExecutionContext): boolean {
    const principal = ctx.switchToHttp().getRequest().user as Principal | undefined;
    if (principal?.kind !== 'service') return false; // user tokens carry no scopes
    return principal.scopes.includes(this.scope);
  }
}

// Usage:
//   @Post('debit')
//   @UseGuards(JwtAuthGuard, new RequireScope('fractals:debit'))
//   async debit() { /* ... */ }
//
// If an endpoint should accept EITHER a user with the right role OR a service
// with the right scope, branch on principal.kind inside one guard instead of
// forcing an M2M token through a role check.

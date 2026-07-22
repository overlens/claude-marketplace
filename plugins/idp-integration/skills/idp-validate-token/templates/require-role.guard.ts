// src/auth/require-role.guard.ts
//
// Authorize a USER by role. Use AFTER JwtAuthGuard so `req.user` is populated.
// Fails closed for service (M2M) tokens — they have no `role`, so a service
// can never satisfy a role check (by design). Gate services with RequireScope.
//
// ⚠️ DEPRECATED authorization source (RFC-0003 / ADR-8): the JWT `role` claim is
// being phased out as an authorization signal. Per ADR-7, a user's role is
// contextual to each app — the IDP authenticates, your app authorizes. This guard
// still works for backward compatibility, but new code should map `sub` → a role
// owned by your own service instead of reading `role` from the token. The claim
// will be removed in a future major version.

import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Principal } from './jwt.strategy';

@Injectable()
export class RequireRole implements CanActivate {
  constructor(private readonly role: 'BASIC' | 'ADMIN' | 'SYSTEM') {}

  canActivate(ctx: ExecutionContext): boolean {
    const principal = ctx.switchToHttp().getRequest().user as Principal | undefined;
    return principal?.kind === 'user' && principal.role === this.role;
  }
}

// Usage:
//   @Controller('admin')
//   @UseGuards(JwtAuthGuard, new RequireRole('ADMIN'))
//   export class AdminController { /* ... */ }

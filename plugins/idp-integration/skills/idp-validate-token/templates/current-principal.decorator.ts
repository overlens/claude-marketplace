// src/auth/current-principal.decorator.ts
//
// Inject the typed Principal into a handler instead of reaching into req.user.
//
//   @Get('me')
//   me(@CurrentPrincipal() principal: Principal) {
//     if (principal.kind !== 'user') throw new ForbiddenException();
//     return this.users.findById(principal.id);
//   }

import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Principal } from './jwt.strategy';

export const CurrentPrincipal = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): Principal =>
    ctx.switchToHttp().getRequest().user,
);

// --- GraphQL variant -------------------------------------------------------
// import { GqlExecutionContext } from '@nestjs/graphql';
//
// export const CurrentPrincipal = createParamDecorator(
//   (_data: unknown, ctx: ExecutionContext): Principal =>
//     GqlExecutionContext.create(ctx).getContext().req.user,
// );

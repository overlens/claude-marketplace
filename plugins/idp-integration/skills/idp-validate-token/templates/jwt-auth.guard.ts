// src/auth/jwt-auth.guard.ts
//
// Drop this on any controller/route that requires a valid token. It runs the
// `jwt` strategy (see jwt.strategy.ts): extracts Bearer-or-cookie, verifies
// RS256 against the cached JWKS, and populates `req.user` with the Principal.
// A missing/expired/invalid token → automatic 401.

import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {}

// --- GraphQL variant (NestJS code-first) -----------------------------------
// In GraphQL the request lives inside the GqlExecutionContext, not the HTTP
// context. Use this instead of JwtAuthGuard on resolvers. Delete if REST-only.
//
// import { ExecutionContext, Injectable } from '@nestjs/common';
// import { AuthGuard } from '@nestjs/passport';
// import { GqlExecutionContext } from '@nestjs/graphql';
//
// @Injectable()
// export class GqlJwtAuthGuard extends AuthGuard('jwt') {
//   getRequest(context: ExecutionContext) {
//     return GqlExecutionContext.create(context).getContext().req;
//   }
// }

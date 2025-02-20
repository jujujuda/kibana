/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { RequestHandlerContextBase } from '@kbn/core-http-server';
import { SetupRouteOptions } from './types';

export function pingRoute<T extends RequestHandlerContextBase>({ router }: SetupRouteOptions<T>) {
  router.get(
    {
      path: `/api/entities/ping`,
      validate: false,
    },
    async (_context, _req, res) => {
      return res.ok({
        body: { message: 'Entity Manager OK' },
        headers: { 'content-type': 'application/json' },
      });
    }
  );
}

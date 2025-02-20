/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { RequestHandlerContext } from '@kbn/core/server';
import { getFakeKibanaRequest } from '@kbn/security-plugin/server/authentication/api_keys/fake_kibana_request';
import { schema } from '@kbn/config-schema';
import { SetupRouteOptions } from '../types';
import {
  checkIfEntityDiscoveryAPIKeyIsValid,
  deleteEntityDiscoveryAPIKey,
  readEntityDiscoveryAPIKey,
} from '../../lib/auth';
import { ERROR_API_KEY_NOT_FOUND, ERROR_API_KEY_NOT_VALID } from '../../../common/errors';
import { uninstallBuiltInEntityDefinitions } from '../../lib/entities/uninstall_entity_definition';

export function disableEntityDiscoveryRoute<T extends RequestHandlerContext>({
  router,
  server,
  logger,
}: SetupRouteOptions<T>) {
  router.delete<unknown, { deleteData?: boolean }, unknown>(
    {
      path: '/internal/api/entities/managed/enablement',
      validate: {
        query: schema.object({
          deleteData: schema.maybe(schema.boolean({ defaultValue: false })),
        }),
      },
    },
    async (context, req, res) => {
      try {
        server.logger.debug('reading entity discovery API key from saved object');
        const apiKey = await readEntityDiscoveryAPIKey(server);

        if (apiKey === undefined) {
          return res.ok({ body: { success: false, reason: ERROR_API_KEY_NOT_FOUND } });
        }

        server.logger.debug('validating existing entity discovery API key');
        const isValid = await checkIfEntityDiscoveryAPIKeyIsValid(server, apiKey);

        if (!isValid) {
          return res.ok({ body: { success: false, reason: ERROR_API_KEY_NOT_VALID } });
        }

        const fakeRequest = getFakeKibanaRequest({ id: apiKey.id, api_key: apiKey.apiKey });
        const soClient = server.core.savedObjects.getScopedClient(fakeRequest);
        const esClient = server.core.elasticsearch.client.asScoped(fakeRequest).asCurrentUser;

        await uninstallBuiltInEntityDefinitions({
          soClient,
          esClient,
          logger,
          deleteData: req.query.deleteData,
        });

        await deleteEntityDiscoveryAPIKey((await context.core).savedObjects.client);
        await server.security.authc.apiKeys.invalidateAsInternalUser({
          ids: [apiKey.id],
        });

        return res.ok({ body: { success: true } });
      } catch (err) {
        logger.error(err);
        return res.customError({ statusCode: 500, body: err });
      }
    }
  );
}

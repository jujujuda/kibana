/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import expect from '@kbn/expect';
import {
  LATEST_FINDINGS_INDEX_DEFAULT_NS,
  LATEST_VULNERABILITIES_INDEX_DEFAULT_NS,
} from '@kbn/cloud-security-posture-plugin/common/constants';
import * as http from 'http';
import { RoleCredentials } from '../../../../../shared/services';
import { getMockFindings, getMockDefendForContainersHeartbeats } from './mock_data'; // eslint-disable-line @kbn/imports/no_boundary_crossing
import type { FtrProviderContext } from '../../../../ftr_provider_context';
import {
  deleteIndex,
  addIndex,
  createPackagePolicy,
  createCloudDefendPackagePolicy,
} from '../../../../../../test/api_integration/apis/cloud_security_posture/helper'; // eslint-disable-line @kbn/imports/no_boundary_crossing
import { UsageRecord, getInterceptedRequestPayload, setupMockServer } from './mock_usage_server'; // eslint-disable-line @kbn/imports/no_boundary_crossing

const CLOUD_DEFEND_HEARTBEAT_INDEX_DEFAULT_NS = 'metrics-cloud_defend.heartbeat-default';

export default function (providerContext: FtrProviderContext) {
  const mockUsageApiApp = setupMockServer();
  const { getService } = providerContext;
  const retry = getService('retry');
  const kibanaServer = getService('kibanaServer');
  const esArchiver = getService('esArchiver');
  const es = getService('es');
  const svlCommonApi = getService('svlCommonApi');
  const svlUserManager = getService('svlUserManager');
  const supertestWithoutAuth = getService('supertestWithoutAuth');

  /*
  This test aims to intercept the usage API request sent by the metering background task manager.
  The task manager is running by default in security serverless project in the background and sending usage API requests to the usage API.
   This test mocks the usage API server and intercepts the usage API request sent by the metering background task manager.
  */
  describe('Intercept the usage API request sent by the metering background task manager', function () {
    this.tags(['skipMKI']);

    let mockUsageApiServer: http.Server;
    let agentPolicyId: string;
    let roleAuthc: RoleCredentials;
    let internalRequestHeader: { 'x-elastic-internal-origin': string; 'kbn-xsrf': string };
    before(async () => {
      mockUsageApiServer = mockUsageApiApp.listen(8081); // Start the usage api mock server on port 8081
    });

    beforeEach(async () => {
      roleAuthc = await svlUserManager.createM2mApiKeyWithRoleScope('admin');
      internalRequestHeader = svlCommonApi.getInternalRequestHeader();

      await kibanaServer.savedObjects.cleanStandardList();
      await esArchiver.load('x-pack/test/functional/es_archives/fleet/empty_fleet_server');

      const { body: agentPolicyResponse } = await supertestWithoutAuth
        .post(`/api/fleet/agent_policies`)
        .set(internalRequestHeader)
        .set(roleAuthc.apiKeyHeader)
        .send({
          name: 'Test policy',
          namespace: 'default',
        });

      agentPolicyId = agentPolicyResponse.item.id;

      await deleteIndex(es, [
        LATEST_FINDINGS_INDEX_DEFAULT_NS,
        LATEST_VULNERABILITIES_INDEX_DEFAULT_NS,
        CLOUD_DEFEND_HEARTBEAT_INDEX_DEFAULT_NS,
      ]);
    });

    afterEach(async () => {
      await deleteIndex(es, [
        LATEST_FINDINGS_INDEX_DEFAULT_NS,
        LATEST_VULNERABILITIES_INDEX_DEFAULT_NS,
      ]);
      await kibanaServer.savedObjects.cleanStandardList();
      await esArchiver.unload('x-pack/test/functional/es_archives/fleet/empty_fleet_server');
      await deleteIndex(es, [
        LATEST_FINDINGS_INDEX_DEFAULT_NS,
        LATEST_VULNERABILITIES_INDEX_DEFAULT_NS,
        CLOUD_DEFEND_HEARTBEAT_INDEX_DEFAULT_NS,
      ]);
    });
    after(async () => {
      await svlUserManager.invalidateM2mApiKeyWithRoleScope(roleAuthc);
      mockUsageApiServer.close();
    });

    it('Should intercept usage API request for CSPM', async () => {
      await createPackagePolicy(
        supertestWithoutAuth,
        agentPolicyId,
        'cspm',
        'cloudbeat/cis_aws',
        'aws',
        'cspm',
        'CSPM-1',
        roleAuthc,
        internalRequestHeader
      );
      const billableFindings = getMockFindings({
        postureType: 'cspm',
        isBillableAsset: true,
        numberOfFindings: 5,
      });

      const notBillableFindings = getMockFindings({
        postureType: 'cspm',
        isBillableAsset: false,
        numberOfFindings: 10,
      });

      await addIndex(
        es,
        [...billableFindings, ...notBillableFindings],
        LATEST_FINDINGS_INDEX_DEFAULT_NS
      );

      let interceptedRequestBody: UsageRecord[] = [];
      await retry.try(async () => {
        interceptedRequestBody = getInterceptedRequestPayload();
        expect(interceptedRequestBody.length).to.greaterThan(0);
        if (interceptedRequestBody.length > 0) {
          const usageSubTypes = interceptedRequestBody.map((record) => record.usage.sub_type);
          expect(usageSubTypes).to.contain('cspm');
        }
      });

      expect(interceptedRequestBody[0].usage.type).to.be('cloud_security');
      expect(interceptedRequestBody[0].usage.quantity).to.be(billableFindings.length);
    });

    it('Should intercept usage API request for KSPM', async () => {
      await createPackagePolicy(
        supertestWithoutAuth,
        agentPolicyId,
        'kspm',
        'cloudbeat/cis_k8s',
        'vanilla',
        'kspm',
        'KSPM-1',
        roleAuthc,
        internalRequestHeader
      );
      const billableFindings = getMockFindings({
        postureType: 'kspm',
        isBillableAsset: true,
        numberOfFindings: 3,
      });

      const notBillableFindings = getMockFindings({
        postureType: 'kspm',
        isBillableAsset: false,
        numberOfFindings: 11,
      });

      await addIndex(
        es,
        [...billableFindings, ...notBillableFindings],
        LATEST_FINDINGS_INDEX_DEFAULT_NS
      );

      let interceptedRequestBody: UsageRecord[] = [];

      await retry.try(async () => {
        interceptedRequestBody = getInterceptedRequestPayload();
        expect(interceptedRequestBody.length).to.greaterThan(0);
        if (interceptedRequestBody.length > 0) {
          const usageSubTypes = interceptedRequestBody.map((record) => record.usage.sub_type);
          expect(usageSubTypes).to.contain('kspm');
        }
      });

      expect(interceptedRequestBody[0].usage.type).to.be('cloud_security');
      expect(interceptedRequestBody[0].usage.quantity).to.be(billableFindings.length);
    });

    it('Should intercept usage API request for CNVM', async () => {
      await createPackagePolicy(
        supertestWithoutAuth,
        agentPolicyId,
        'vuln_mgmt',
        'cloudbeat/vuln_mgmt_aws',
        'aws',
        'vuln_mgmt',
        'CNVM-1',
        roleAuthc,
        internalRequestHeader
      );

      const billableFindings = getMockFindings({
        postureType: 'cnvm',
        numberOfFindings: 2,
      });

      await addIndex(es, billableFindings, LATEST_VULNERABILITIES_INDEX_DEFAULT_NS);

      let interceptedRequestBody: UsageRecord[] = [];

      await retry.try(async () => {
        interceptedRequestBody = getInterceptedRequestPayload();
        expect(interceptedRequestBody.length).to.greaterThan(0);
        if (interceptedRequestBody.length > 0) {
          const usageSubTypes = interceptedRequestBody.map((record) => record.usage.sub_type);
          expect(usageSubTypes).to.contain('cnvm');
        }
      });

      expect(interceptedRequestBody[0].usage.type).to.be('cloud_security');
      expect(interceptedRequestBody[0].usage.quantity).to.be(billableFindings.length);
    });

    it('Should intercept usage API request for Defend for Containers', async () => {
      await createCloudDefendPackagePolicy(
        supertestWithoutAuth,
        agentPolicyId,
        roleAuthc,
        internalRequestHeader
      );

      const blockActionEnabledHeartbeats = getMockDefendForContainersHeartbeats({
        isBlockActionEnables: true,
        numberOfHearbeats: 2,
      });

      const blockActionDisabledHeartbeats = getMockDefendForContainersHeartbeats({
        isBlockActionEnables: false,
        numberOfHearbeats: 2,
      });
      await addIndex(
        es,
        [...blockActionEnabledHeartbeats, ...blockActionDisabledHeartbeats],
        CLOUD_DEFEND_HEARTBEAT_INDEX_DEFAULT_NS
      );

      let interceptedRequestBody: UsageRecord[] = [];

      await retry.try(async () => {
        interceptedRequestBody = getInterceptedRequestPayload();
        expect(interceptedRequestBody.length).to.greaterThan(0);
        if (interceptedRequestBody.length > 0) {
          const usageSubTypes = interceptedRequestBody.map((record) => record.usage.sub_type);
          expect(usageSubTypes).to.contain('cloud_defend');
        }
      });

      expect(interceptedRequestBody.length).to.be(blockActionEnabledHeartbeats.length);
      expect(interceptedRequestBody[0].usage.type).to.be('cloud_security');
    });

    it('Should intercept usage API request with all integrations usage records', async () => {
      // Create one package policy - it takes care forCSPM, KSMP and CNVM
      await createPackagePolicy(
        supertestWithoutAuth,
        agentPolicyId,
        'cspm',
        'cloudbeat/cis_aws',
        'aws',
        'cspm',
        'CSPM-1',
        roleAuthc,
        internalRequestHeader
      );

      // Create Defend for Containers package policy
      await createCloudDefendPackagePolicy(
        supertestWithoutAuth,
        agentPolicyId,
        roleAuthc,
        internalRequestHeader
      );
      const billableFindingsCSPM = getMockFindings({
        postureType: 'cspm',
        isBillableAsset: true,
        numberOfFindings: 5,
      });

      const notBillableFindingsCSPM = getMockFindings({
        postureType: 'cspm',
        isBillableAsset: false,
        numberOfFindings: 10,
      });

      const billableFindingsKSPM = getMockFindings({
        postureType: 'kspm',
        isBillableAsset: true,
        numberOfFindings: 3,
      });

      const billableFindingsCNVM = getMockFindings({
        postureType: 'cnvm',
        numberOfFindings: 2,
      });

      const notBillableFindingsKSPM = getMockFindings({
        postureType: 'kspm',
        isBillableAsset: false,
        numberOfFindings: 11,
      });

      const blockActionEnabledHeartbeats = getMockDefendForContainersHeartbeats({
        isBlockActionEnables: true,
        numberOfHearbeats: 2,
      });

      const blockActionDisabledHeartbeats = getMockDefendForContainersHeartbeats({
        isBlockActionEnables: false,
        numberOfHearbeats: 2,
      });

      await Promise.all([
        addIndex(
          es,
          [
            ...billableFindingsCSPM,
            ...notBillableFindingsCSPM,
            ...billableFindingsKSPM,
            ...notBillableFindingsKSPM,
          ],
          LATEST_FINDINGS_INDEX_DEFAULT_NS
        ),
        addIndex(es, [...billableFindingsCNVM], LATEST_VULNERABILITIES_INDEX_DEFAULT_NS),
        addIndex(
          es,
          [...blockActionEnabledHeartbeats, ...blockActionDisabledHeartbeats],
          CLOUD_DEFEND_HEARTBEAT_INDEX_DEFAULT_NS
        ),
      ]);

      // Intercept and verify usage API request
      let interceptedRequestBody: UsageRecord[] = [];

      await retry.try(async () => {
        interceptedRequestBody = getInterceptedRequestPayload();
        const usageSubTypes = interceptedRequestBody.map((record) => record.usage.sub_type);

        expect(usageSubTypes).to.contain('cspm');
        expect(usageSubTypes).to.contain('kspm');
        expect(usageSubTypes).to.contain('cnvm');
        expect(usageSubTypes).to.contain('cloud_defend');
      });

      const totalUsageQuantity = interceptedRequestBody.reduce(
        (acc, record) => acc + record.usage.quantity,
        0
      );
      expect(totalUsageQuantity).to.be(
        billableFindingsCSPM.length +
          billableFindingsKSPM.length +
          billableFindingsCNVM.length +
          blockActionEnabledHeartbeats.length
      );
    });
  });
}

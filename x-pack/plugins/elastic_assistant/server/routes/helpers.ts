/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import {
  AnalyticsServiceSetup,
  IKibanaResponse,
  KibanaRequest,
  KibanaResponseFactory,
  Logger,
} from '@kbn/core/server';
import { StreamResponseWithHeaders } from '@kbn/ml-response-stream/server';

import {
  TraceData,
  ConversationResponse,
  ExecuteConnectorRequestBody,
  Message,
  Replacements,
  replaceAnonymizedValuesWithOriginalValues,
} from '@kbn/elastic-assistant-common';
import { ILicense } from '@kbn/licensing-plugin/server';
import { i18n } from '@kbn/i18n';
import { AwaitedProperties, PublicMethodsOf } from '@kbn/utility-types';
import { ActionsClient } from '@kbn/actions-plugin/server';
import { AssistantFeatureKey } from '@kbn/elastic-assistant-common/impl/capabilities';
import { getLangSmithTracer } from '@kbn/langchain/server/tracers/langsmith';
import { MINIMUM_AI_ASSISTANT_LICENSE } from '../../common/constants';
import { ESQL_RESOURCE, KNOWLEDGE_BASE_INDEX_PATTERN } from './knowledge_base/constants';
import { callAgentExecutor } from '../lib/langchain/execute_custom_llm_chain';
import { buildResponse, getLlmType } from './utils';
import {
  AgentExecutorParams,
  AssistantDataClients,
  StaticReturnType,
} from '../lib/langchain/executors/types';
import { executeAction, StaticResponse } from '../lib/executor';
import { getLangChainMessages } from '../lib/langchain/helpers';

import { ElasticsearchStore } from '../lib/langchain/elasticsearch_store/elasticsearch_store';
import { AIAssistantConversationsDataClient } from '../ai_assistant_data_clients/conversations';
import { INVOKE_ASSISTANT_SUCCESS_EVENT } from '../lib/telemetry/event_based_telemetry';
import { ElasticAssistantRequestHandlerContext, GetElser } from '../types';
import { callAssistantGraph } from '../lib/langchain/graphs/default_assistant_graph';

interface GetPluginNameFromRequestParams {
  request: KibanaRequest;
  defaultPluginName: string;
  logger?: Logger;
}

export const DEFAULT_PLUGIN_NAME = 'securitySolutionUI';

export const NEW_CHAT = i18n.translate('xpack.elasticAssistantPlugin.server.newChat', {
  defaultMessage: 'New chat',
});

/**
 * Attempts to extract the plugin name the request originated from using the request headers.
 *
 * Note from Kibana Core: This is not a 100% fit solution, though, because plugins can run in the background,
 * or even use other plugins’ helpers (ie, APM can use the infra helpers to call a third plugin)
 *
 * Should suffice for our purposes here with where the Elastic Assistant is currently used, but if needing a
 * dedicated solution, the core folks said to reach out.
 *
 * @param logger optional logger to log any errors
 * @param defaultPluginName default plugin name to use if unable to determine from request
 * @param request Kibana Request
 *
 * @returns plugin name
 */
export const getPluginNameFromRequest = ({
  logger,
  defaultPluginName,
  request,
}: GetPluginNameFromRequestParams): string => {
  try {
    const contextHeader = request.headers['x-kbn-context'];
    if (contextHeader != null) {
      return JSON.parse(
        decodeURIComponent(Array.isArray(contextHeader) ? contextHeader[0] : contextHeader)
      )?.name;
    }
  } catch (err) {
    logger?.error(
      `Error determining source plugin for selecting tools, using ${defaultPluginName}.`
    );
  }
  return defaultPluginName;
};

export const getMessageFromRawResponse = ({
  rawContent,
  isError,
  traceData,
}: {
  rawContent?: string;
  traceData?: TraceData;
  isError?: boolean;
}): Message => {
  const dateTimeString = new Date().toISOString();
  if (rawContent) {
    return {
      role: 'assistant',
      content: rawContent,
      timestamp: dateTimeString,
      isError,
      traceData,
    };
  } else {
    return {
      role: 'assistant',
      content: 'Error: Response from LLM API is empty or undefined.',
      timestamp: dateTimeString,
      isError: true,
    };
  }
};

export const hasAIAssistantLicense = (license: ILicense): boolean =>
  license.hasAtLeast(MINIMUM_AI_ASSISTANT_LICENSE);

export const UPGRADE_LICENSE_MESSAGE =
  'Your license does not support AI Assistant. Please upgrade your license.';

export interface GenerateTitleForNewChatConversationParams {
  message: Pick<Message, 'content' | 'role'>;
  model?: string;
  actionTypeId: string;
  connectorId: string;
  logger: Logger;
  actionsClient: PublicMethodsOf<ActionsClient>;
  responseLanguage?: string;
}
export const generateTitleForNewChatConversation = async ({
  message,
  model,
  actionTypeId,
  connectorId,
  logger,
  actionsClient,
  responseLanguage = 'English',
}: GenerateTitleForNewChatConversationParams) => {
  try {
    const autoTitle = (await executeAction({
      actionsClient,
      connectorId,
      actionTypeId,
      params: {
        subAction: 'invokeAI',
        subActionParams: {
          model,
          messages: [
            {
              role: 'system',
              content: `You are a helpful assistant for Elastic Security. Assume the following message is the start of a conversation between you and a user; give this conversation a title based on the content below. DO NOT UNDER ANY CIRCUMSTANCES wrap this title in single or double quotes. This title is shown in a list of conversations to the user, so title it for the user, not for you. Please create the title in ${responseLanguage}.`,
            },
            {
              role: message.role,
              content: message.content,
            },
          ],
          ...(actionTypeId === '.gen-ai'
            ? { n: 1, stop: null, temperature: 0.2 }
            : { temperature: 0, stopSequences: [] }),
        },
      },
      logger,
    })) as unknown as StaticResponse; // TODO: Use function overloads in executeAction to avoid this cast when sending subAction: 'invokeAI',
    if (autoTitle.status === 'ok') {
      // This regular expression captures a string enclosed in single or double quotes.
      // It extracts the string content without the quotes.
      // Example matches:
      // - "Hello, World!" => Captures: Hello, World!
      // - 'Another Example' => Captures: Another Example
      // - JustTextWithoutQuotes => Captures: JustTextWithoutQuotes
      const match = autoTitle.data.match(/^["']?([^"']+)["']?$/);
      const title = match ? match[1] : autoTitle.data;
      return title;
    }
  } catch (e) {
    /* empty */
  }
};

export interface AppendMessageToConversationParams {
  conversationsDataClient: AIAssistantConversationsDataClient;
  messages: Array<Pick<Message, 'content' | 'role'>>;
  replacements: Replacements;
  conversation: ConversationResponse;
}
export const appendMessageToConversation = async ({
  conversationsDataClient,
  messages,
  replacements,
  conversation,
}: AppendMessageToConversationParams) => {
  const updatedConversation = await conversationsDataClient?.appendConversationMessages({
    existingConversation: conversation,
    messages: messages.map((m) => ({
      ...{
        content: replaceAnonymizedValuesWithOriginalValues({
          messageContent: m.content,
          replacements,
        }),
        role: m.role ?? 'user',
      },
      timestamp: new Date().toISOString(),
    })),
  });
  return updatedConversation;
};

export interface AppendAssistantMessageToConversationParams {
  conversationsDataClient: AIAssistantConversationsDataClient;
  messageContent: string;
  replacements: Replacements;
  conversationId: string;
  isError?: boolean;
  traceData?: Message['traceData'];
}
export const appendAssistantMessageToConversation = async ({
  conversationsDataClient,
  messageContent,
  replacements,
  conversationId,
  isError = false,
  traceData = {},
}: AppendAssistantMessageToConversationParams) => {
  const conversation = await conversationsDataClient.getConversation({ id: conversationId });
  if (!conversation) {
    return;
  }

  await conversationsDataClient.appendConversationMessages({
    existingConversation: conversation,
    messages: [
      getMessageFromRawResponse({
        rawContent: replaceAnonymizedValuesWithOriginalValues({
          messageContent,
          replacements,
        }),
        traceData,
        isError,
      }),
    ],
  });
  if (Object.keys(replacements).length > 0) {
    await conversationsDataClient?.updateConversation({
      conversationUpdateProps: {
        id: conversation.id,
        replacements,
      },
    });
  }
};

export interface NonLangChainExecuteParams {
  request: KibanaRequest<unknown, unknown, ExecuteConnectorRequestBody>;
  messages: Array<Pick<Message, 'content' | 'role'>>;
  abortSignal: AbortSignal;
  actionTypeId: string;
  connectorId: string;
  logger: Logger;
  actionsClient: PublicMethodsOf<ActionsClient>;
  onLlmResponse?: (
    content: string,
    traceData?: Message['traceData'],
    isError?: boolean
  ) => Promise<void>;
  response: KibanaResponseFactory;
  telemetry: AnalyticsServiceSetup;
}
export const nonLangChainExecute = async ({
  messages,
  abortSignal,
  actionTypeId,
  connectorId,
  logger,
  actionsClient,
  onLlmResponse,
  response,
  request,
  telemetry,
}: NonLangChainExecuteParams) => {
  logger.debug('Executing via actions framework directly');
  const result = await executeAction({
    abortSignal,
    onLlmResponse,
    actionsClient,
    connectorId,
    actionTypeId,
    params: {
      subAction: request.body.subAction,
      subActionParams: {
        model: request.body.model,
        messages,
        ...(actionTypeId === '.gen-ai'
          ? { n: 1, stop: null, temperature: 0.2 }
          : { temperature: 0, stopSequences: [] }),
      },
    },
    logger,
  });

  telemetry.reportEvent(INVOKE_ASSISTANT_SUCCESS_EVENT.eventType, {
    actionTypeId,
    isEnabledKnowledgeBase: request.body.isEnabledKnowledgeBase,
    isEnabledRAGAlerts: request.body.isEnabledRAGAlerts,
    model: request.body.model,
    assistantStreamingEnabled: request.body.subAction !== 'invokeAI',
  });
  return response.ok({
    body: result,
    ...(request.body.subAction === 'invokeAI'
      ? { headers: { 'content-type': 'application/json' } }
      : {}),
  });
};

export interface LangChainExecuteParams {
  messages: Array<Pick<Message, 'content' | 'role'>>;
  replacements: Replacements;
  isEnabledKnowledgeBase: boolean;
  isStream?: boolean;
  onNewReplacements: (newReplacements: Replacements) => void;
  abortSignal: AbortSignal;
  telemetry: AnalyticsServiceSetup;
  actionTypeId: string;
  connectorId: string;
  conversationId?: string;
  context: AwaitedProperties<
    Pick<ElasticAssistantRequestHandlerContext, 'elasticAssistant' | 'licensing' | 'core'>
  >;
  actionsClient: PublicMethodsOf<ActionsClient>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  request: KibanaRequest<unknown, unknown, any>;
  logger: Logger;
  onLlmResponse?: (
    content: string,
    traceData?: Message['traceData'],
    isError?: boolean
  ) => Promise<void>;
  getElser: GetElser;
  response: KibanaResponseFactory;
  responseLanguage?: string;
}
export const langChainExecute = async ({
  messages,
  replacements,
  onNewReplacements,
  isEnabledKnowledgeBase,
  abortSignal,
  telemetry,
  actionTypeId,
  connectorId,
  context,
  actionsClient,
  request,
  logger,
  conversationId,
  onLlmResponse,
  getElser,
  response,
  responseLanguage,
  isStream = true,
}: LangChainExecuteParams) => {
  // TODO: Add `traceId` to actions request when calling via langchain
  logger.debug(
    `Executing via langchain, isEnabledKnowledgeBase: ${isEnabledKnowledgeBase}, isEnabledRAGAlerts: ${request.body.isEnabledRAGAlerts}`
  );
  // Fetch any tools registered by the request's originating plugin
  const pluginName = getPluginNameFromRequest({
    request,
    defaultPluginName: DEFAULT_PLUGIN_NAME,
    logger,
  });
  const assistantContext = context.elasticAssistant;
  const assistantTools = assistantContext
    .getRegisteredTools(pluginName)
    .filter((x) => x.id !== 'attack-discovery'); // We don't (yet) support asking the assistant for NEW attack discoveries from a conversation

  // get a scoped esClient for assistant memory
  const esClient = context.core.elasticsearch.client.asCurrentUser;

  // convert the assistant messages to LangChain messages:
  const langChainMessages = getLangChainMessages(messages);

  const elserId = await getElser();

  const anonymizationFieldsDataClient =
    await assistantContext.getAIAssistantAnonymizationFieldsDataClient();
  const conversationsDataClient = await assistantContext.getAIAssistantConversationsDataClient();

  // Create an ElasticsearchStore for KB interactions
  // Setup with kbDataClient if `assistantKnowledgeBaseByDefault` FF is enabled
  const enableKnowledgeBaseByDefault =
    assistantContext.getRegisteredFeatures(pluginName).assistantKnowledgeBaseByDefault;
  const kbDataClient = enableKnowledgeBaseByDefault
    ? (await assistantContext.getAIAssistantKnowledgeBaseDataClient(false)) ?? undefined
    : undefined;
  const kbIndex =
    enableKnowledgeBaseByDefault && kbDataClient != null
      ? kbDataClient.indexTemplateAndPattern.alias
      : KNOWLEDGE_BASE_INDEX_PATTERN;
  const esStore = new ElasticsearchStore(
    esClient,
    kbIndex,
    logger,
    telemetry,
    elserId,
    ESQL_RESOURCE,
    kbDataClient
  );

  const dataClients: AssistantDataClients = {
    anonymizationFieldsDataClient: anonymizationFieldsDataClient ?? undefined,
    conversationsDataClient: conversationsDataClient ?? undefined,
    kbDataClient,
  };

  // Shared executor params
  const executorParams: AgentExecutorParams<boolean> = {
    abortSignal,
    dataClients,
    alertsIndexPattern: request.body.alertsIndexPattern,
    actionsClient,
    isEnabledKnowledgeBase,
    assistantTools,
    conversationId,
    connectorId,
    esClient,
    esStore,
    isStream,
    llmType: getLlmType(actionTypeId),
    langChainMessages,
    logger,
    onNewReplacements,
    onLlmResponse,
    request,
    replacements,
    responseLanguage,
    size: request.body.size,
    traceOptions: {
      projectName: request.body.langSmithProject,
      tracers: getLangSmithTracer({
        apiKey: request.body.langSmithApiKey,
        projectName: request.body.langSmithProject,
        logger,
      }),
    },
  };

  // New code path for LangGraph implementation, behind `assistantKnowledgeBaseByDefault` FF
  let result: StreamResponseWithHeaders | StaticReturnType;
  if (enableKnowledgeBaseByDefault && request.body.isEnabledKnowledgeBase) {
    result = await callAssistantGraph(executorParams);
  } else {
    result = await callAgentExecutor(executorParams);
  }

  telemetry.reportEvent(INVOKE_ASSISTANT_SUCCESS_EVENT.eventType, {
    actionTypeId,
    isEnabledKnowledgeBase,
    isEnabledRAGAlerts: request.body.isEnabledRAGAlerts ?? true,
    model: request.body.model,
    // TODO rm actionTypeId check when llmClass for bedrock streaming is implemented
    // tracked here: https://github.com/elastic/security-team/issues/7363
    assistantStreamingEnabled: isStream && actionTypeId === '.gen-ai',
  });
  return response.ok<StreamResponseWithHeaders['body'] | StaticReturnType['body']>(result);
};

export interface CreateOrUpdateConversationWithParams {
  logger: Logger;
  conversationsDataClient: AIAssistantConversationsDataClient;
  replacements: Replacements;
  conversationId?: string;
  promptId?: string;
  actionTypeId: string;
  connectorId: string;
  actionsClient: PublicMethodsOf<ActionsClient>;
  newMessages?: Array<Pick<Message, 'content' | 'role'>>;
  model?: string;
  responseLanguage?: string;
}
export const createOrUpdateConversationWithUserInput = async ({
  logger,
  conversationsDataClient,
  replacements,
  conversationId,
  actionTypeId,
  promptId,
  connectorId,
  actionsClient,
  newMessages,
  model,
  responseLanguage,
}: CreateOrUpdateConversationWithParams) => {
  if (!conversationId) {
    if (newMessages && newMessages.length > 0) {
      const title = await generateTitleForNewChatConversation({
        message: newMessages[0],
        actionsClient,
        actionTypeId,
        connectorId,
        logger,
        model,
        responseLanguage,
      });
      if (title) {
        return conversationsDataClient.createConversation({
          conversation: {
            title,
            messages: newMessages.map((m) => ({
              content: m.content,
              role: m.role,
              timestamp: new Date().toISOString(),
            })),
            replacements,
            apiConfig: {
              connectorId,
              actionTypeId,
              model,
              defaultSystemPromptId: promptId,
            },
          },
        });
      }
    }
    return;
  }
  return updateConversationWithUserInput({
    actionsClient,
    actionTypeId,
    connectorId,
    conversationId,
    conversationsDataClient,
    logger,
    replacements,
    newMessages,
    model,
  });
};

export interface UpdateConversationWithParams {
  logger: Logger;
  conversationsDataClient: AIAssistantConversationsDataClient;
  replacements: Replacements;
  conversationId: string;
  actionTypeId: string;
  connectorId: string;
  actionsClient: PublicMethodsOf<ActionsClient>;
  newMessages?: Array<Pick<Message, 'content' | 'role'>>;
  model?: string;
}
export const updateConversationWithUserInput = async ({
  logger,
  conversationsDataClient,
  replacements,
  conversationId,
  actionTypeId,
  connectorId,
  actionsClient,
  newMessages,
  model,
}: UpdateConversationWithParams) => {
  const conversation = await conversationsDataClient?.getConversation({
    id: conversationId,
  });
  if (conversation == null) {
    throw new Error(`conversation id: "${conversationId}" not found`);
  }
  let updatedConversation = conversation;

  const messages = updatedConversation?.messages?.map((c) => ({
    role: c.role,
    content: c.content,
    timestamp: c.timestamp,
  }));

  const lastMessage = newMessages?.[0] ?? messages?.[0];

  if (conversation?.title === NEW_CHAT && lastMessage) {
    const title = await generateTitleForNewChatConversation({
      message: lastMessage,
      actionsClient,
      actionTypeId,
      connectorId,
      logger,
      model,
    });
    const res = await conversationsDataClient.updateConversation({
      conversationUpdateProps: {
        id: conversationId,
        title,
      },
    });
    if (res) {
      updatedConversation = res;
    }
  }

  if (newMessages) {
    return appendMessageToConversation({
      conversation: updatedConversation,
      conversationsDataClient,
      messages: newMessages,
      replacements,
    });
  }
  return updatedConversation;
};

interface PerformChecksParams {
  authenticatedUser?: boolean;
  capability?: AssistantFeatureKey;
  context: AwaitedProperties<
    Pick<ElasticAssistantRequestHandlerContext, 'elasticAssistant' | 'licensing' | 'core'>
  >;
  license?: boolean;
  request: KibanaRequest;
  response: KibanaResponseFactory;
}

/**
 * Helper to perform checks for authenticated user, capability, and license. Perform all or one
 * of the checks by providing relevant optional params. Check order is license, authenticated user,
 * then capability.
 *
 * @param authenticatedUser - Whether to check for an authenticated user
 * @param capability - Specific capability to check if enabled, e.g. `assistantModelEvaluation`
 * @param context - Route context
 * @param license - Whether to check for a valid license
 * @param request - Route KibanaRequest
 * @param response - Route KibanaResponseFactory
 */
export const performChecks = ({
  authenticatedUser,
  capability,
  context,
  license,
  request,
  response,
}: PerformChecksParams): IKibanaResponse | undefined => {
  const assistantResponse = buildResponse(response);

  if (license) {
    if (!hasAIAssistantLicense(context.licensing.license)) {
      return response.forbidden({
        body: {
          message: UPGRADE_LICENSE_MESSAGE,
        },
      });
    }
  }

  if (authenticatedUser) {
    if (context.elasticAssistant.getCurrentUser() == null) {
      return assistantResponse.error({
        body: `Authenticated user not found`,
        statusCode: 401,
      });
    }
  }

  if (capability) {
    const pluginName = getPluginNameFromRequest({
      request,
      defaultPluginName: DEFAULT_PLUGIN_NAME,
    });
    const registeredFeatures = context.elasticAssistant.getRegisteredFeatures(pluginName);
    if (!registeredFeatures[capability]) {
      return response.notFound();
    }
  }

  return undefined;
};

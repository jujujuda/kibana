/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */
import moment from 'moment';
import { EuiExpression, EuiFieldNumber, EuiFormRow, EuiPopover } from '@elastic/eui';
import { i18n } from '@kbn/i18n';
import React, { useState } from 'react';
import {
  ERROR_GROUP_ID,
  SERVICE_ENVIRONMENT,
  SERVICE_NAME,
  TRANSACTION_TYPE,
  TRANSACTION_NAME,
} from '../../../../common/es_fields/apm';
import {
  ENVIRONMENT_ALL,
  getEnvironmentLabel,
  allOptionText,
} from '../../../../common/environment_filter_values';
import { SuggestionsSelect } from '../../shared/suggestions_select';
import { PopoverExpression } from '../ui_components/popover_expression';

export function ServiceField({
  allowAll = true,
  currentValue,
  onChange,
}: {
  allowAll?: boolean;
  currentValue?: string;
  onChange: (value?: string) => void;
}) {
  return (
    <PopoverExpression
      value={currentValue || allOptionText}
      title={i18n.translate('xpack.apm.alerting.fields.service', {
        defaultMessage: 'Service',
      })}
    >
      <SuggestionsSelect
        customOptions={allowAll ? [{ label: allOptionText, value: undefined }] : undefined}
        customOptionText={i18n.translate('xpack.apm.serviceNamesSelectCustomOptionText', {
          defaultMessage: `Add '{searchValue}' as a new service name`,
        })}
        defaultValue={currentValue}
        fieldName={SERVICE_NAME}
        onChange={onChange}
        placeholder={i18n.translate('xpack.apm.serviceNamesSelectPlaceholder', {
          defaultMessage: 'Select service name',
        })}
        start={moment().subtract(24, 'h').toISOString()}
        end={moment().toISOString()}
      />
    </PopoverExpression>
  );
}

export function EnvironmentField({
  currentValue,
  onChange,
  serviceName,
}: {
  currentValue: string;
  onChange: (value?: string) => void;
  serviceName?: string;
}) {
  return (
    <PopoverExpression
      value={getEnvironmentLabel(currentValue)}
      title={i18n.translate('xpack.apm.alerting.fields.environment', {
        defaultMessage: 'Environment',
      })}
    >
      <SuggestionsSelect
        customOptions={[ENVIRONMENT_ALL]}
        customOptionText={i18n.translate('xpack.apm.environmentsSelectCustomOptionText', {
          defaultMessage: `Add '{searchValue}' as a new environment`,
        })}
        defaultValue={getEnvironmentLabel(currentValue)}
        fieldName={SERVICE_ENVIRONMENT}
        onChange={onChange}
        placeholder={i18n.translate('xpack.apm.environmentsSelectPlaceholder', {
          defaultMessage: 'Select environment',
        })}
        start={moment().subtract(24, 'h').toISOString()}
        end={moment().toISOString()}
        serviceName={serviceName}
      />
    </PopoverExpression>
  );
}

export function TransactionNameField({
  currentValue,
  onChange,
  serviceName,
}: {
  currentValue?: string;
  onChange: (value?: string) => void;
  serviceName?: string;
}) {
  const label = i18n.translate('xpack.apm.alerting.fields.transaction.name', {
    defaultMessage: 'Name',
  });

  return (
    <PopoverExpression value={currentValue || allOptionText} title={label}>
      <SuggestionsSelect
        customOptions={[{ label: allOptionText, value: undefined }]}
        customOptionText={i18n.translate('xpack.apm.alerting.transaction.name.custom.text', {
          defaultMessage: `Add '{searchValue}' as a new transaction name`,
        })}
        defaultValue={currentValue}
        fieldName={TRANSACTION_NAME}
        onChange={onChange}
        placeholder={i18n.translate('xpack.apm.transactionNamesSelectPlaceholder', {
          defaultMessage: 'Select transaction name',
        })}
        start={moment().subtract(24, 'h').toISOString()}
        end={moment().toISOString()}
        serviceName={serviceName}
      />
    </PopoverExpression>
  );
}

export function TransactionTypeField({
  currentValue,
  onChange,
  serviceName,
}: {
  currentValue?: string;
  onChange: (value?: string) => void;
  serviceName?: string;
}) {
  const label = i18n.translate('xpack.apm.alerting.fields.type', {
    defaultMessage: 'Type',
  });
  return (
    <PopoverExpression value={currentValue || allOptionText} title={label}>
      <SuggestionsSelect
        customOptions={[{ label: allOptionText, value: undefined }]}
        customOptionText={i18n.translate('xpack.apm.transactionTypesSelectCustomOptionText', {
          defaultMessage: `Add '{searchValue}' as a new transaction type`,
        })}
        defaultValue={currentValue}
        fieldName={TRANSACTION_TYPE}
        onChange={onChange}
        placeholder={i18n.translate('xpack.apm.transactionTypesSelectPlaceholder', {
          defaultMessage: 'Select transaction type',
        })}
        start={moment().subtract(24, 'h').toISOString()}
        end={moment().toISOString()}
        serviceName={serviceName}
      />
    </PopoverExpression>
  );
}

export function ErrorGroupingKeyField({
  currentValue,
  onChange,
  serviceName,
}: {
  currentValue?: string;
  onChange: (value?: string) => void;
  serviceName?: string;
}) {
  const label = i18n.translate('xpack.apm.alerting.fields.error.group.id', {
    defaultMessage: 'Error grouping key',
  });
  return (
    <PopoverExpression value={currentValue || allOptionText} title={label}>
      <SuggestionsSelect
        customOptions={[{ label: allOptionText, value: undefined }]}
        customOptionText={i18n.translate('xpack.apm.errorKeySelectCustomOptionText', {
          defaultMessage: `Add '{searchValue}' as a new error grouping key`,
        })}
        defaultValue={currentValue}
        fieldName={ERROR_GROUP_ID}
        onChange={onChange}
        placeholder={i18n.translate('xpack.apm.errorGroupingKeySelectPlaceholder', {
          defaultMessage: 'Select error grouping key',
        })}
        start={moment().subtract(24, 'h').toISOString()}
        end={moment().toISOString()}
        serviceName={serviceName}
      />
    </PopoverExpression>
  );
}

function isNumeric(value: string): boolean {
  return !isNaN(Number(value)) && value.trim() !== '';
}

export function IsAboveField({
  value,
  unit,
  onChange,
  step,
}: {
  value: number;
  unit: string;
  onChange: (value: number) => void;
  step?: number;
}) {
  const [thresholdPopoverOpen, serThresholdPopoverOpen] = useState(false);
  const [isAboveValue, setIsAboveValue] = useState(String(value));

  return (
    <EuiPopover
      isOpen={thresholdPopoverOpen}
      anchorPosition={'downLeft'}
      ownFocus
      closePopover={() => {
        serThresholdPopoverOpen(false);
      }}
      button={
        <EuiExpression
          value={`${value}${unit}`}
          description={i18n.translate('xpack.apm.transactionErrorRateRuleType.isAbove', {
            defaultMessage: 'is above',
          })}
          isInvalid={!isNumeric(isAboveValue)}
          isActive={thresholdPopoverOpen}
          onClick={() => {
            serThresholdPopoverOpen(true);
          }}
        />
      }
    >
      <EuiFormRow
        isInvalid={!isNumeric(isAboveValue)}
        error={i18n.translate('xpack.apm.transactionErrorRateRuleType.error.validThreshold', {
          defaultMessage: 'Thresholds must contain a valid number.',
        })}
      >
        <EuiFieldNumber
          data-test-subj="apmIsAboveFieldFieldNumber"
          min={0}
          value={isAboveValue}
          onChange={(e) => {
            const thresholdVal = e.target.value;
            // Update the value to continue typing (if user stopped at . or ,)
            setIsAboveValue(thresholdVal);
            // Only send the value back to the rule if it's a valid number
            if (!isNaN(Number(thresholdVal))) {
              onChange(Number(thresholdVal));
            }
          }}
          append={unit}
          isInvalid={!isNumeric(isAboveValue)}
          compressed
          step={step}
        />
      </EuiFormRow>
    </EuiPopover>
  );
}

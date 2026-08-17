import React from 'react';
import { useUserPreferences } from '@src/hooks';
import { Card, CardContent } from '@src/components/ui/card';
import { Typography } from '../ui';
import { AutomationService } from '@src/services/automation.service';
import { cn } from '@src/lib/utils';
import { createLogger } from '@extension/shared/lib/logger';
import { CodeReviewAccessFa } from '../../CodeReviewAccessFa';

const logger = createLogger('Settings');

const DEFAULT_DELAYS = {
  autoInsertDelay: 2,
  autoSubmitDelay: 2,
  autoExecuteDelay: 2
} as const;

const Settings: React.FC = () => {
  const { preferences, updatePreferences } = useUserPreferences();

  const handleDelayChange = (type: 'autoInsert' | 'autoSubmit' | 'autoExecute', value: string) => {
    const delay = Math.max(0, parseInt(value) || 0);
    logger.debug(`${type} delay changed to: ${delay}`);
    updatePreferences({ [`${type}Delay`]: delay });

    try {
      const storedDelays = JSON.parse(localStorage.getItem('mcpDelaySettings') || '{}');
      localStorage.setItem('mcpDelaySettings', JSON.stringify({
        ...storedDelays,
        [`${type}Delay`]: delay
      }));
    } catch (error) {
      logger.error('[Settings] Error storing delay settings:', error);
    }

    AutomationService.getInstance().updateAutomationStateOnWindow().catch(console.error);
  };

  React.useEffect(() => {
    try {
      const storedDelays = JSON.parse(localStorage.getItem('mcpDelaySettings') || '{}');
      if (Object.keys(storedDelays).length === 0) {
        updatePreferences(DEFAULT_DELAYS);
        localStorage.setItem('mcpDelaySettings', JSON.stringify(DEFAULT_DELAYS));
      } else {
        updatePreferences(storedDelays);
      }
    } catch (error) {
      logger.error('[Settings] Error loading stored delay settings:', error);
      updatePreferences(DEFAULT_DELAYS);
    }
  }, [updatePreferences]);

  return (
    <div className="p-4 space-y-4">
      <CodeReviewAccessFa
        owner=""
        repo=""
        onApprove={async (duration) => {
          await chrome.runtime.sendMessage({
            type: 'code-review:approve',
            payload: {
              owner: '',
              repo: '',
              durationMinutes: duration,
            },
          });
        }}
        onRevoke={async () => {
          await chrome.runtime.sendMessage({
            type: 'code-review:revoke',
          });
        }}
      />

      <Card className="border-slate-200 dark:border-slate-700 dark:bg-slate-800">
        <CardContent className="p-4">
          <Typography variant="h4" className="mb-4 text-slate-700 dark:text-slate-300">
            Automation Delay Settings
          </Typography>
          <div className="space-y-4">
            {(['autoInsert','autoSubmit','autoExecute'] as const).map(type => (
              <div key={type}>
                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
                  {type} Delay (seconds)
                </label>
                <input
                  type="number"
                  min="0"
                  value={preferences[`${type}Delay`] || 0}
                  onChange={(e) => handleDelayChange(type, e.target.value)}
                  className={cn(
                    'w-full p-2 text-sm border rounded-md',
                    'bg-white dark:bg-slate-900',
                    'border-slate-300 dark:border-slate-600'
                  )}
                />
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
};

export default Settings;

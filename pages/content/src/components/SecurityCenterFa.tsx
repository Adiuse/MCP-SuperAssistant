import React, { useEffect, useMemo, useState } from 'react';

type AuditFilter = 'all' | 'allowed' | 'blocked';

interface CodeReviewSession {
  id: string;
  owner: string;
  repo: string;
  approvedTabId: number;
  startedAt: number;
  expiresAt: number;
  durationMinutes: 5 | 10 | 20;
  callCount: number;
  responseBytes: number;
}

interface CodeReviewAuditEntry {
  timestamp: number;
  action:
    | 'access_requested'
    | 'session_started'
    | 'session_rev
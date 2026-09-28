import { env } from '../config/env';
import { logger } from '../lib/logger';
import { finfinityClient } from './finfinityClient';

export interface LeadStatus {
  /** A display label for the current status — the mock uses its own tiny 'pending'/'synced'/
   * 'failed' vocabulary, the real backend returns whatever LeadStatus metadata value is current
   * (e.g. "Application Accepted") via fetchstatusdata's statusData.value. Callers (see
   * flows/homeLoan.ts's STATUS_LABEL lookup) already fall back to the raw string when it isn't one
   * of the handful they have a friendlier phrasing for, so either vocabulary works as-is. */
  status: string;
  builderLeadId: string | null;
}

export interface StatusService {
  /** Post-completion polling — checks on a lead/application after the chat flow has already
   * finished, e.g. from a returning customer or a status-check page. Not part of the live flow.
   * NOTE: the "check an existing application" conversation branch that calls this has no OTP step
   * of its own today, so there's no fresh access token available to pass as `token` — this is a
   * known gap (real access tokens are short-lived, so even a token saved from an earlier completed
   * conversation would likely already be expired by the time someone returns to check status).
   * Needs its own auth step designed in, same as the bureau question/OTP step. */
  getStatus(builderLeadId: string, token?: string): Promise<LeadStatus>;
}

/** Mock — just reports back the sync status the (mock) Lead-creation call already recorded. */
class MockStatusService implements StatusService {
  async getStatus(builderLeadId: string): Promise<LeadStatus> {
    logger.info({ event: 'status_check_mock', builderLeadId }, 'mock status check');
    return { status: 'pending', builderLeadId };
  }
}

interface FetchStatusDataResponse {
  remarks: string;
  assign_to: number;
  statusData: { id: number; key: string; value: string; metadata_type: string; metadata_name: string; description: string | null };
  bpData: unknown;
  lenderData: unknown;
}

/** Real status API — GET /leadflow/fetchstatusdata/<leadid>. builderLeadId is exactly the leadid
 * create_anacity_lead returned (see lead.service.ts), stored as a string in our own Lead row. */
class RealStatusService implements StatusService {
  async getStatus(builderLeadId: string, token?: string): Promise<LeadStatus> {
    const results = await finfinityClient.get<FetchStatusDataResponse[]>(`/leadflow/fetchstatusdata/${builderLeadId}`, { token });
    const result = results[0];
    if (!result) throw new Error('fetchstatusdata returned no data');
    return { status: result.statusData.value, builderLeadId };
  }
}

export const statusService: StatusService = env.FINFINITY_API_BASE_URL ? new RealStatusService() : new MockStatusService();

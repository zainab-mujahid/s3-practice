import { HealthController } from './health.controller.js';

describe('HealthController', () => {
  it('returns status ok with an ISO timestamp and nothing else', () => {
    const res = new HealthController().check();
    expect(res.status).toBe('ok');
    expect(new Date(res.timestamp).toISOString()).toBe(res.timestamp);
    expect(Object.keys(res).sort()).toEqual(['status', 'timestamp']);
  });
});

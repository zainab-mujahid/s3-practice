import { Controller, Get } from '@nestjs/common';

export interface HealthResponse {
  status: 'ok';
  timestamp: string;
}

/**
 * Liveness check only. Deliberately reveals nothing about configuration,
 * buckets, region or AWS identity, and makes no AWS calls.
 */
@Controller('health')
export class HealthController {
  @Get()
  check(): HealthResponse {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }
}

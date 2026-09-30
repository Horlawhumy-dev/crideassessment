import { Inject, Injectable } from '@nestjs/common';
import { USERS_REPOSITORY, type UsersRepository } from '../users/users.repository';
import { assertRole, type Principal } from '../rides/domain/ride-policy';
import { UserNotFoundError } from '../common/errors/domain-error';

export interface AvailabilityView {
  readonly driverId: string;
  readonly isAvailable: boolean;
}

/**
 * Availability is a driver-only fact, so the policy is applied here rather than in the
 * controller. It is persisted, not just socket state: the durable value is what the UI
 * renders after a reload, and `drivers:available` room membership is derived from it.
 */
@Injectable()
export class DriverAvailabilityService {
  constructor(@Inject(USERS_REPOSITORY) private readonly users: UsersRepository) {}

  async get(principal: Principal): Promise<AvailabilityView> {
    assertRole(principal, 'DRIVER');

    const driver = await this.users.findById(principal.userId);
    if (!driver) throw new UserNotFoundError(principal.userId);

    return { driverId: driver.id, isAvailable: driver.isAvailable };
  }

  async set(principal: Principal, isAvailable: boolean): Promise<AvailabilityView> {
    assertRole(principal, 'DRIVER');

    const driver = await this.users.setAvailability(principal.userId, isAvailable);
    if (!driver) throw new UserNotFoundError(principal.userId);

    return { driverId: driver.id, isAvailable: driver.isAvailable };
  }
}

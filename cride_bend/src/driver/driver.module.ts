import { Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module';
import { DriverAvailabilityService } from './driver-availability.service';
import { DriverController } from './driver.controller';

@Module({
  imports: [UsersModule],
  controllers: [DriverController],
  providers: [DriverAvailabilityService],
  exports: [DriverAvailabilityService],
})
export class DriverModule {}

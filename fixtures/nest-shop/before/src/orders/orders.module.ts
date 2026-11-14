import { Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module';
import { OrdersService } from './orders.service';

@Module({
  imports: [UsersModule],
  providers: [OrdersService],
})
export class OrdersModule {}

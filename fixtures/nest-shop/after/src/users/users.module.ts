import { Module, forwardRef } from '@nestjs/common';
import { OrdersModule } from '../orders/orders.module';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { InMemoryUsersRepository } from './repository/in-memory-users.repository';
import { USERS_REPOSITORY } from './repository/users.repository';

@Module({
  imports: [forwardRef(() => OrdersModule)],
  controllers: [UsersController],
  providers: [
    UsersService,
    { provide: USERS_REPOSITORY, useClass: InMemoryUsersRepository },
    { provide: 'CLOCK', useFactory: () => () => Date.now() },
  ],
  exports: [UsersService],
})
export class UsersModule {}

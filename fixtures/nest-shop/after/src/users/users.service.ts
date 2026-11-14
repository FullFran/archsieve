import { Inject, Injectable, forwardRef } from '@nestjs/common';
import { OrdersService } from '../orders/orders.service';
import { USERS_REPOSITORY, UsersRepository } from './repository/users.repository';

export interface User {
  id: string;
  name: string;
}

@Injectable()
export class UsersService {
  constructor(
    @Inject(USERS_REPOSITORY) private readonly repo: UsersRepository,
    @Inject(forwardRef(() => OrdersService)) private readonly orders: OrdersService,
  ) {}

  findOne(id: string): User | undefined {
    return this.repo.findOne(id);
  }
}

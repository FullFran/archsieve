import { Injectable, Inject, forwardRef } from '@nestjs/common';
import { UsersService } from '../users/users.service';

@Injectable()
export class OrdersService {
  constructor(@Inject(forwardRef(() => UsersService)) private readonly users: UsersService) {}

  placeOrder(userId: string, item: string) {
    const user = this.users.findOne(userId);
    if (!user) throw new Error('unknown user');
    return { user: user.id, item };
  }
}

import { Injectable } from '@nestjs/common';
import { UsersService } from '../users/users.service';

@Injectable()
export class OrdersService {
  constructor(private readonly users: UsersService) {}

  placeOrder(userId: string, item: string) {
    const user = this.users.findOne(userId);
    if (!user) throw new Error('unknown user');
    return { user: user.id, item };
  }
}

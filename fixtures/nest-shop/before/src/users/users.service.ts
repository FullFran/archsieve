import { Injectable } from '@nestjs/common';

export interface User {
  id: string;
  name: string;
}

@Injectable()
export class UsersService {
  private readonly users: User[] = [{ id: '1', name: 'Ada' }];

  findOne(id: string): User | undefined {
    return this.users.find((u) => u.id === id);
  }
}

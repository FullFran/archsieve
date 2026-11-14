import { Injectable } from '@nestjs/common';
import { User } from '../users.service';
import { UsersRepository } from './users.repository';

@Injectable()
export class InMemoryUsersRepository implements UsersRepository {
  private readonly users: User[] = [{ id: '1', name: 'Ada' }];

  findOne(id: string): User | undefined {
    return this.users.find((u) => u.id === id);
  }
}

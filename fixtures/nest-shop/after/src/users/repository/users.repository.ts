import { User } from '../users.service';

export const USERS_REPOSITORY = 'USERS_REPOSITORY';

export interface UsersRepository {
  findOne(id: string): User | undefined;
}

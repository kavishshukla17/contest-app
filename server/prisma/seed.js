import bcrypt from 'bcryptjs'
import { prisma } from '../src/db.js'

async function main() {
  const teacherHash = await bcrypt.hash('teacher123', 10)
  const studentHash = await bcrypt.hash('student123', 10)

  await prisma.user.upsert({
    where: { email: 'teacher@college.edu' },
    create: {
      name: 'Teacher Demo',
      email: 'teacher@college.edu',
      passwordHash: teacherHash,
      role: 'teacher',
    },
    update: {},
  })

  await prisma.user.upsert({
    where: { email: 'student@college.edu' },
    create: {
      name: 'Student Demo',
      email: 'student@college.edu',
      passwordHash: studentHash,
      role: 'student',
    },
    update: {},
  })

  console.log('Seeded demo users')
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect())

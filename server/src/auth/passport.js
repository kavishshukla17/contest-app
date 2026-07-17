import passport from 'passport'
import { Strategy as JwtStrategy, ExtractJwt } from 'passport-jwt'
import { Strategy as LocalStrategy } from 'passport-local'
import bcrypt from 'bcryptjs'
import { prisma } from '../db.js'

const jwtSecret = process.env.JWT_SECRET ?? 'contest-dev-secret'

passport.use(
  new LocalStrategy({ usernameField: 'email' }, async (email, password, done) => {
    try {
      const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } })
      if (!user) return done(null, false, { message: 'Invalid credentials' })
      const ok = await bcrypt.compare(password, user.passwordHash)
      if (!ok) return done(null, false, { message: 'Invalid credentials' })
      return done(null, {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
      })
    } catch (err) {
      return done(err)
    }
  }),
)

passport.use(
  new JwtStrategy(
    {
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: jwtSecret,
    },
    async (payload, done) => {
      try {
        const user = await prisma.user.findUnique({ where: { id: payload.sub } })
        if (!user) return done(null, false)
        return done(null, {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
        })
      } catch (err) {
        return done(err)
      }
    },
  ),
)

export { passport, jwtSecret }

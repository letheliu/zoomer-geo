import type { Atom, ScoredAtom, AtomScore } from './types.js'

const WEIGHTS = {
  numericAnchor: 35,
  entityAnchor: 25,
  selfContained: 25,
  definition: 15,
} as const

const THRESHOLD = 70

const NUMERIC_REGEX = /\d/

function hasNumericAnchor(atom: Atom): boolean {
  if (NUMERIC_REGEX.test(atom.text)) return true
  return atom.anchors.some((a) => NUMERIC_REGEX.test(a))
}

function hasEntityAnchor(atom: Atom): boolean {
  return atom.anchors.some((a) => !NUMERIC_REGEX.test(a))
}

function isSelfContained(atom: Atom): boolean {
  return !!(atom.subject && atom.predicate && atom.object)
}

function hasDefinition(atom: Atom): boolean {
  return !!atom.definition
}

function scoreAtom(atom: Atom): AtomScore {
  const hasNum = hasNumericAnchor(atom)
  const hasEnt = hasEntityAnchor(atom)
  const selfContained = isSelfContained(atom)
  const hasDef = hasDefinition(atom)

  const total =
    (hasNum ? WEIGHTS.numericAnchor : 0) +
    (hasEnt ? WEIGHTS.entityAnchor : 0) +
    (selfContained ? WEIGHTS.selfContained : 0) +
    (hasDef ? WEIGHTS.definition : 0)

  return {
    total,
    hasNumericAnchor: hasNum,
    hasEntityAnchor: hasEnt,
    isSelfContained: selfContained,
    hasDefinition: hasDef,
  }
}

export interface ScoringService {
  scoreAtoms(atoms: Atom[]): ScoredAtom[]
  scorePage(scored: ScoredAtom[]): number
}

export function createScoringEngine(): ScoringService {
  return {
    scoreAtoms(atoms) {
      return atoms.map((atom) => ({ ...atom, score: scoreAtom(atom) }))
    },

    scorePage(scored) {
      if (scored.length === 0) return 0
      const sum = scored.reduce((acc, a) => acc + a.score.total, 0)
      return Math.round(sum / scored.length)
    },
  }
}

export { THRESHOLD }

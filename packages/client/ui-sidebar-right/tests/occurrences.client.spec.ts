/** Navigation targets and the drawing ledger shared by panel occurrences. */
import { describe, expect, it } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { SidebarRightOccurrences } from '../src/client/occurrences.ts'

const A = 's-a' as SessionId
const B = 's-b' as SessionId

describe('SidebarRightOccurrences', () => {
  it('reports the most recently entered embedded occurrence and restores the previous one', () => {
    const occurrences = new SidebarRightOccurrences()
    expect(occurrences.current()).toBeUndefined()
    const leaveA = occurrences.enterEmbedded(A)
    expect(occurrences.current()).toEqual({ sessionId: A, host: 'embedded' })
    const leaveB = occurrences.enterEmbedded(B)
    expect(occurrences.current()).toEqual({ sessionId: B, host: 'embedded' })
    leaveB()
    expect(occurrences.current()).toEqual({ sessionId: A, host: 'embedded' })
    leaveA()
    expect(occurrences.current()).toBeUndefined()
  })

  it('counts embedded occurrences per Session and releases each entry once', () => {
    const occurrences = new SidebarRightOccurrences()
    const drawing = occurrences.drawingSource(A)
    const leaveFirst = occurrences.enterEmbedded(A)
    expect(drawing.getSnapshot()).toBe(1)
    const leaveSecond = occurrences.enterEmbedded(A)
    expect(drawing.getSnapshot()).toBe(2)
    leaveFirst()
    leaveFirst()
    expect(drawing.getSnapshot()).toBe(1)
    leaveSecond()
    expect(drawing.getSnapshot()).toBe(0)
  })

  it('keeps one Session drawing count independent of another', () => {
    const occurrences = new SidebarRightOccurrences()
    const leaveA = occurrences.enterEmbedded(A)
    expect(occurrences.drawingSource(A).getSnapshot()).toBe(1)
    expect(occurrences.drawingSource(B).getSnapshot()).toBe(0)
    leaveA()
    expect(occurrences.drawingSource(A).getSnapshot()).toBe(0)
  })

  it('drops a Session ledger on forget, keeping the stack untouched', () => {
    const occurrences = new SidebarRightOccurrences()
    const leave = occurrences.enterEmbedded(A)
    occurrences.forget(A)
    expect(occurrences.drawingSource(A).getSnapshot()).toBe(0)
    expect(occurrences.current()).toEqual({ sessionId: A, host: 'embedded' })
    leave()
    expect(occurrences.current()).toBeUndefined()
  })
})

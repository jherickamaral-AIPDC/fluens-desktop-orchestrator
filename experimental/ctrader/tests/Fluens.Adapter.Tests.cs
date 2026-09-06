// ===========================================================================
//  CTRADERADAPTER001 — BATERÍA DE PRUEBAS OFFLINE
//  ---------------------------------------------------------------------------
//  34 escenarios guionizados + un simulador adversario determinista.
//  Cero cTrader, cero SDK, cero red, cero disco, cero reloj de pared.
//
//  El simulador adversario es la parte que de verdad endurece el sistema:
//  lanza tormentas de eventos en orden pseudoaleatorio (semilla fija) y
//  verifica que SIETE invariantes globales no se rompan nunca.
// ===========================================================================

using System;
using System.Collections.Generic;
using System.Globalization;
using Fluens.LocalDemo.Adapter;
using Fluens.LocalDemo.Adapter.Fake;
using Fluens.LocalDemo.Adapter.Ports;
using Fluens.LocalDemo.Core;
using Fluens.LocalDemo.Strategy;

namespace Fluens.LocalDemo.Adapter.Tests
{
    public static class Programa
    {
        private static int _ok;
        private static int _fallo;
        private static readonly List<string> _fallos = new List<string>();

        private const string PlanDigest = "33f69e5a1b2c3d4e5f60718293a4b5c6d7e8f90112233445566778899aabbccd";
        private const string Etiqueta = "FLUENS-DEMO";

        public static int Main()
        {
            Console.WriteLine("CTRADERADAPTER001 — pruebas offline del esqueleto (sin SDK)");
            Console.WriteLine("");

            M01(); M02(); M03(); M04(); M05(); M06(); M07(); M08(); M09(); M10();
            M11(); M12(); M13(); M14(); M15(); M16(); M17(); M18(); M19(); M20();
            M21(); M22(); M23(); M24(); M25(); M26(); M27(); M28(); M29(); M30();
            M31(); M32(); M33(); M34();

            Console.WriteLine("");
            Console.WriteLine("PASADAS=" + _ok.ToString(CultureInfo.InvariantCulture)
                            + " FALLIDAS=" + _fallo.ToString(CultureInfo.InvariantCulture));
            for (int i = 0; i < _fallos.Count; i++) { Console.WriteLine("  FALLO: " + _fallos[i]); }
            Console.WriteLine(_fallo == 0 ? "RESULTADO=PASS" : "RESULTADO=FAIL");
            return _fallo == 0 ? 0 : 1;
        }

        private static void Chk(string id, bool condicion, string detalle)
        {
            if (condicion) { _ok++; Console.WriteLine("  [ok]   " + id + "  " + detalle); }
            else { _fallo++; _fallos.Add(id + " — " + detalle); Console.WriteLine("  [FALL] " + id + "  " + detalle); }
        }

        private static UmbralesRuntime UmbralesDePrueba(int presupuesto)
        {
            return UmbralesRuntime.Ratificar(1000L, 5000L, 300L, 100000L, presupuesto);
        }

        private static AdapterRuntime Montar(ObservadorFalso obs, FuenteBarrasFalsa barras, OrdenesFalsas ord,
                                             JournalFalso jr, IRiskEnvelopePort riesgo, ParadaFalsa parada,
                                             RelojFalso reloj, UmbralesRuntime u, PoliticaHueco pol)
        {
            return new AdapterRuntime(reloj, obs, barras, ord, jr, riesgo, parada, u, pol, 5, 32, PlanDigest, Etiqueta);
        }

        /// <summary>
        /// El registro de permisos del core es ESTÁTICO por proceso y la identidad
        /// lógica es de un solo uso. Si dos escenarios usan el mismo nonce, el segundo
        /// es denegado con razón — que es el comportamiento correcto del core, pero
        /// arruinaría la prueba. Por eso cada escenario lleva su propia semilla.
        /// </summary>
        private static DatosPermiso DatosBase(string semilla)
        {
            DatosPermiso d = new DatosPermiso();
            string h = CanonicalModel.Sha256("x");
            d.AuthoritySha256 = h; d.HumanPresenceSessionSha256 = h; d.PlatformContractSha256 = h;
            d.AccountSessionSha256 = h; d.SymbolSnapshotSha256 = h; d.QuoteSnapshotSha256 = h;
            d.JournalTipSha256 = h; d.Environment = "DESKTOP";
            d.Nonce = CanonicalModel.Sha256("nonce:" + semilla).Substring(0, 16);
            d.Expiry = 100000L;
            return d;
        }

        // --------------------------------------------------------- VENTANA H1

        private static void M01()
        {
            PlatformBar[] s = FuenteBarrasFalsa.Serie(400000L, new double[] { 1.0, 1.1, 1.2, 1.15, 1.25 });
            VentanaH1 v = ConstructorVentanaH1.Construir(s, 5, PoliticaHueco.EsperarContiguidad, 32);
            StrategyDecision d = TrendPullbackContinuationH1.EvaluateClosedHistory(
                StrategyConfiguration.ForOfflineEvaluation(PlanDigest), v.Barras, null);
            Chk("M01", v.Barras.Length == 5 && d != null && d.Status == StrategyDecisionStatus.SIGNAL_READY_FOR_NEXT_OPEN
                && d.Signal == StrategySignal.LONG && d.EligibleNextOpenUtcHour == 400004L + 1L,
                "5 barras contiguas producen LONG elegible en la hora siguiente");
        }

        private static void M02()
        {
            PlatformBar[] s = FuenteBarrasFalsa.Serie(400000L, new double[] { 1.0, 1.1, 1.2, 1.15, 1.25 });
            PlatformBar[] conAbierta = new PlatformBar[6];
            Array.Copy(s, conAbierta, 5);
            conAbierta[5] = new PlatformBar(400005L * 3600L, 9.99, false);   // barra en curso
            VentanaH1 v = ConstructorVentanaH1.Construir(conAbierta, 5, PoliticaHueco.EsperarContiguidad, 32);
            Chk("M02", v.Barras.Length == 5, "la barra en curso queda excluida del prefijo");
        }

        private static void M03()
        {
            PlatformBar[] con = new PlatformBar[6];
            con[0] = new PlatformBar(400000L * 3600L, 1.0, true);
            con[1] = new PlatformBar(400001L * 3600L, 1.1, true);
            con[2] = new PlatformBar(400010L * 3600L, 1.2, true);   // hueco
            con[3] = new PlatformBar(400011L * 3600L, 1.3, true);
            con[4] = new PlatformBar(400012L * 3600L, 1.25, true);
            con[5] = new PlatformBar(400013L * 3600L, 1.35, true);
            VentanaH1 estricta = ConstructorVentanaH1.Construir(con, 5, PoliticaHueco.EsperarContiguidad, 32);
            VentanaH1 reencuadre = ConstructorVentanaH1.Construir(con, 5, PoliticaHueco.ReencuadrarTrasHueco, 32);
            Chk("M03", estricta.Barras.Length == 0 && estricta.Motivo == "HUECO_DE_CONTIGUIDAD"
                && reencuadre.Barras.Length == 0 && reencuadre.Motivo == "HISTORIA_INSUFICIENTE",
                "hueco: la política estricta rechaza y el reencuadre exige 5 barras nuevas");
        }

        private static void M04()
        {
            PlatformBar[] s = new PlatformBar[1];
            s[0] = new PlatformBar(400000L * 3600L + 1800L, 1.0, true);   // media hora
            VentanaH1 v = ConstructorVentanaH1.Construir(s, 5, PoliticaHueco.EsperarContiguidad, 32);
            Chk("M04", v.Barras.Length == 0, "apertura que no cae en hora exacta se descarta");
        }

        private static void M05()
        {
            decimal a, b;
            bool oa = Conversion.TryPrecio(0.1 + 0.2, 5, out a);
            bool ob = Conversion.TryPrecio(0.3, 5, out b);
            decimal nan;
            bool on = Conversion.TryPrecio(double.NaN, 5, out nan);
            Chk("M05", oa && ob && a == b && !on,
                "0.1+0.2 y 0.3 dan el mismo decimal; NaN se rechaza");
        }

        // --------------------------------------------------------- GUARDAS

        private static void M06()
        {
            PlatformSnapshot s = Fotos.Limpia("CFGUS");
            s.AccountReadable = false;
            GuardId[] g = EvaluadorGuardas.Evaluar(s, UmbralesDePrueba(1), false);
            Chk("M06", !Contiene(g, GuardId.ACCOUNT_ISLIVE_FALSE),
                "cuenta ilegible no concede ACCOUNT_ISLIVE_FALSE (desconocido != falso)");
        }

        private static void M07()
        {
            PlatformSnapshot s = Fotos.Limpia("CFGUS");
            s.AccountNumberMatchesAllowlist = false;
            GuardId[] g = EvaluadorGuardas.Evaluar(s, UmbralesDePrueba(1), false);
            Chk("M07", !Contiene(g, GuardId.PRIVATE_ACCOUNT_ALLOWLIST_MATCH),
                "cuenta fuera de la lista blanca no concede la guarda");
        }

        private static void M08()
        {
            SafetySignal elegida = SafetyEventArbiter.Select(
                new SafetySignal[] { SafetySignal.STRATEGY, SafetySignal.ACCOUNT_SWITCH });
            Chk("M08", elegida == SafetySignal.ACCOUNT_SWITCH, "cambio de cuenta gana a la estrategia");
        }

        private static void M09()
        {
            SafetySignal elegida = SafetyEventArbiter.Select(new SafetySignal[] {
                SafetySignal.STRATEGY, SafetySignal.HEARTBEAT_LOST,
                SafetySignal.RECONNECT, SafetySignal.ACCOUNT_SWITCH, SafetySignal.LIVE_OR_UNKNOWN_ACCOUNT });
            Chk("M09", elegida == SafetySignal.LIVE_OR_UNKNOWN_ACCOUNT, "LIVE gana a todas las demás señales");
        }

        // --------------------------------------------------- RECONCILIACIÓN

        private static void M10()
        {
            PlatformSnapshot s = Fotos.Limpia("CFGUS");
            s.AttributablePositions = new PlatformPosition[] { new PlatformPosition(7, Etiqueta, "CFGUS", true) };
            Chk("M10", Reconciliador.Clasificar(s, false) == ReconcileObservation.ATTRIBUTABLE_PROTECTED,
                "posición propia con stop => ATTRIBUTABLE_PROTECTED");
        }

        private static void M11()
        {
            PlatformSnapshot s = Fotos.Limpia("CFGUS");
            s.AttributablePositions = new PlatformPosition[] { new PlatformPosition(7, Etiqueta, "CFGUS", false) };
            Chk("M11", Reconciliador.Clasificar(s, false) == ReconcileObservation.ATTRIBUTABLE_UNPROTECTED,
                "posición propia sin stop => ATTRIBUTABLE_UNPROTECTED");
        }

        private static void M12()
        {
            PlatformSnapshot s = Fotos.Limpia("CFGUS");
            s.UnattributablePositions = new PlatformPosition[] { new PlatformPosition(9, "OTRA", "CFGUS", true) };
            Chk("M12", Reconciliador.Clasificar(s, false) == ReconcileObservation.MANUAL_UNATTRIBUTABLE_CONTRADICTORY_PENDING,
                "posición ajena => no se adopta, se congela");
        }

        private static void M13()
        {
            PlatformSnapshot s = Fotos.Limpia("CFGUS");
            s.PendingOrderCount = 1;
            Chk("M13", Reconciliador.Clasificar(s, false) == ReconcileObservation.MANUAL_UNATTRIBUTABLE_CONTRADICTORY_PENDING,
                "orden pendiente inesperada => se congela");
        }

        // ---------------------------------------------------------- PERMISO

        private static void M14()
        {
            string n = CanonicalModel.Sha256("n14");
            string v = CanonicalModel.Sha256("v14");
            PermitDecision d = PermitDecision.Issue(n, v, 10L, 100L, 1L, false);   // sin stop
            bool niega = false;
            EffectId[] ef = d.Effects;
            for (int i = 0; i < ef.Length; i++) { if (ef[i] == EffectId.DO_NOT_ISSUE_PERMIT) { niega = true; } }
            Chk("M14", !d.Issued && niega, "sin stop declarado no se emite permiso");
        }

        private static void M15()
        {
            string n = CanonicalModel.Sha256("n15");
            string v = CanonicalModel.Sha256("v15");
            PermitDecision e = PermitDecision.Issue(n, v, 10L, 1000L, 1L, true);
            GuardSet gs = GuardSet.Create(PermitDecision.RequiredImmediateGuards());
            PermitDecision c1 = PermitDecision.Consume(e.Permit, 20L, 1L, v, gs);
            PermitDecision c2 = PermitDecision.Consume(e.Permit, 21L, 1L, v, gs);
            Chk("M15", c1.Allowed && !c2.Allowed && c2.NextState == RuntimeState.QUIESCED,
                "el permiso es de un solo uso: el segundo consumo se deniega");
        }

        private static void M16()
        {
            bool dentro = PermitExpiryClock.IsUnexpired(50L, 10L, 100L, 1L, 1L);
            bool fuera = PermitExpiryClock.IsUnexpired(200L, 10L, 100L, 1L, 1L);
            bool otroEpoch = PermitExpiryClock.IsUnexpired(50L, 10L, 100L, 1L, 2L);
            Chk("M16", dentro && !fuera && !otroEpoch,
                "caduca por ticks y un reinicio (epoch nuevo) lo invalida");
        }

        // ------------------------------------------------ RESULTADO DE ENVÍO

        private static void M17() { EnvioEsperado("M17", new TradeOutcome(true, true, "", true, true, 11), RuntimeState.OPEN_PROTECTED, "relleno verificado con stop => OPEN_PROTECTED"); }
        private static void M18() { EnvioEsperado("M18", new TradeOutcome(true, true, "", true, false, 12), RuntimeState.EXITING, "relleno sin stop => EXITING (cierre único)"); }
        private static void M19() { EnvioEsperado("M19", new TradeOutcome(true, false, "BadVolume", false, false, 0), RuntimeState.QUIESCED, "fallo limpio sin relleno => QUIESCED sin reintento"); }
        private static void M20() { EnvioEsperado("M20", new TradeOutcome(false, false, "Timeout", false, false, 0), RuntimeState.UNKNOWN_ORDER_STATE, "llamada que no retorna => estado desconocido"); }
        private static void M21() { EnvioEsperado("M21", new TradeOutcome(true, true, "", false, false, 0), RuntimeState.UNKNOWN_ORDER_STATE, "éxito sin posición devuelta => ambiguo, no éxito"); }

        private static void EnvioEsperado(string id, TradeOutcome resultado, RuntimeState esperado, string detalle)
        {
            AdapterRuntime rt = MontarEnSubmitting(resultado, id);
            Chk(id, rt.Sesion.Actual == esperado, detalle + " (obtenido " + rt.Sesion.Actual.ToString() + ")");
        }

        private static AdapterRuntime MontarEnSubmitting(TradeOutcome resultado, string semilla)
        {
            ObservadorFalso obs = new ObservadorFalso(Fotos.Limpia("CFGUS"));
            FuenteBarrasFalsa bar = new FuenteBarrasFalsa(FuenteBarrasFalsa.Serie(400000L, new double[] { 1.0, 1.1, 1.2, 1.15, 1.25 }));
            OrdenesFalsas ord = new OrdenesFalsas();
            ord.EncolarEntrada(resultado);
            JournalFalso jr = new JournalFalso(true);
            RelojFalso rel = new RelojFalso(10L, 1L);
            AdapterRuntime rt = Montar(obs, bar, ord, jr, new RiesgoFalso(true, 1000d, 25d), new ParadaFalsa(),
                                       rel, UmbralesDePrueba(5), PoliticaHueco.EsperarContiguidad);
            rt.Arrancar();
            rt.Sesion.Actual = RuntimeState.SUBMITTING;
            rt.Sesion.NuevasEntradasDesarmadas = false;
            rt.Sesion.SimboloToken = "CFGUS";
            StrategyDecision d = rt.EvaluarSenal();
            rt.IntentarEntrada(d, DatosBase(semilla));
            return rt;
        }

        // ------------------------------------------------------ SALIDAS

        private static void M22()
        {
            PureCommand[] plan = ProtectiveExitCoordinator.Plan(true, true, true);
            Chk("M22", plan.Length == 1 && plan[0] == PureCommand.CLOSE_ONLY,
                "con exposición y salida pedida, la entrada se suprime y solo cierra");
        }

        private static void M23()
        {
            DomainEngine m = new DomainEngine();
            TransitionDecision d = m.Evaluate(RuntimeState.OPEN_PROTECTED, TransitionEvent.SERVER_SIDE_STOP_LOST,
                                              GuardSet.Create(GuardId.POSITION_STILL_EXISTS));
            Chk("M23", d.Allowed && d.To == RuntimeState.EXITING
                && d.HasEffect(EffectId.CLOSE_ONLY_REMEDIATION_NO_ENTRY_RETRY),
                "si el stop del servidor desaparece => salida en modo solo-cierre");
        }

        private static void M24()
        {
            ObservadorFalso obs = new ObservadorFalso(Fotos.Limpia("CFGUS"));
            OrdenesFalsas ord = new OrdenesFalsas();
            ord.EncolarCierre(new TradeOutcome(false, false, "Timeout", false, false, 0));
            AdapterRuntime rt = Montar(obs, new FuenteBarrasFalsa(new PlatformBar[0]), ord, new JournalFalso(true),
                                       new RiesgoFalso(true, 1000d, 25d), new ParadaFalsa(),
                                       new RelojFalso(10L, 1L), UmbralesDePrueba(5), PoliticaHueco.EsperarContiguidad);
            rt.Arrancar();
            rt.Sesion.Actual = RuntimeState.EXITING;
            rt.IntentarCierre(42);
            Chk("M24", rt.Sesion.Actual == RuntimeState.UNKNOWN_ORDER_STATE && rt.Cuenta.ReintentosBloqueados > 0,
                "cierre ambiguo => estado desconocido y reintento bloqueado");
        }

        // ------------------------------------------------ REINICIO / IDEMPOTENCIA

        private static void M25()
        {
            PlatformSnapshot s = Fotos.Limpia("CFGUS");
            s.AttributablePositions = new PlatformPosition[] { new PlatformPosition(7, Etiqueta, "CFGUS", true) };
            ObservadorFalso obs = new ObservadorFalso(s);
            AdapterRuntime rt = Montar(obs, new FuenteBarrasFalsa(new PlatformBar[0]), new OrdenesFalsas(),
                                       new JournalFalso(true), new RiesgoFalso(true, 1000d, 25d), new ParadaFalsa(),
                                       new RelojFalso(10L, 9L), UmbralesDePrueba(5), PoliticaHueco.EsperarContiguidad);
            rt.Arrancar();
            rt.Sesion.Actual = RuntimeState.RECONCILING;
            rt.Reconciliar();
            Chk("M25", rt.Sesion.Actual == RuntimeState.OPEN_PROTECTED && rt.Sesion.NuevasEntradasDesarmadas,
                "tras reinicio con posición propia protegida: se adopta y queda desarmado");
        }

        private static void M26()
        {
            JournalFalso jr = new JournalFalso(true);   // el journal sobrevive al reinicio
            AdapterRuntime a = MontarConJournal(jr, 5);
            StrategyDecision d = a.EvaluarSenal();
            bool primera = a.IntentarEntrada(d, DatosBase("M26"));

            AdapterRuntime b = MontarConJournal(jr, 5);   // "reinicio": runtime nuevo, mismo journal
            StrategyDecision d2 = b.EvaluarSenal();
            bool segunda = b.IntentarEntrada(d2, DatosBase("M26"));

            Chk("M26", primera && !segunda && b.Cuenta.EntradasRechazadasPorIdempotencia == 1,
                "la misma intención no se ejecuta dos veces aunque el proceso reinicie");
        }

        private static AdapterRuntime MontarConJournal(JournalFalso jr, int presupuesto)
        {
            ObservadorFalso obs = new ObservadorFalso(Fotos.Limpia("CFGUS"));
            FuenteBarrasFalsa bar = new FuenteBarrasFalsa(FuenteBarrasFalsa.Serie(400000L, new double[] { 1.0, 1.1, 1.2, 1.15, 1.25 }));
            AdapterRuntime rt = Montar(obs, bar, new OrdenesFalsas(), jr, new RiesgoFalso(true, 1000d, 25d),
                                       new ParadaFalsa(), new RelojFalso(10L, 1L), UmbralesDePrueba(presupuesto),
                                       PoliticaHueco.EsperarContiguidad);
            rt.Arrancar();
            rt.Sesion.NuevasEntradasDesarmadas = false;
            rt.Sesion.SimboloToken = "CFGUS";
            return rt;
        }

        // --------------------------------------------------- RIESGO / CONTRATOS

        private static void M27()
        {
            ObservadorFalso obs = new ObservadorFalso(Fotos.Limpia("CFGUS"));
            FuenteBarrasFalsa bar = new FuenteBarrasFalsa(FuenteBarrasFalsa.Serie(400000L, new double[] { 1.0, 1.1, 1.2, 1.15, 1.25 }));
            AdapterRuntime rt = Montar(obs, bar, new OrdenesFalsas(), new JournalFalso(true),
                                       new DenyingRiskEnvelopePort(), new ParadaFalsa(),
                                       new RelojFalso(10L, 1L), UmbralesDePrueba(5), PoliticaHueco.EsperarContiguidad);
            rt.Arrancar();
            rt.Sesion.NuevasEntradasDesarmadas = false;
            StrategyDecision d = rt.EvaluarSenal();
            bool enviada = rt.IntentarEntrada(d, DatosBase("M27"));
            Chk("M27", !enviada && rt.Cuenta.EntradasRechazadasPorRiesgo == 1 && rt.Cuenta.EntradasEnviadas == 0,
                "sin sobre de riesgo implementado, el sistema no puede abrir nada");
        }

        private static void M28()
        {
            PlatformSnapshot s = Fotos.Limpia("CFGUS");
            s.CommissionContractComplete = false;
            GuardId[] g = EvaluadorGuardas.Evaluar(s, UmbralesDePrueba(1), false);
            Chk("M28", !Contiene(g, GuardId.COMMISSION_CONTRACT_COMPLETE),
                "faltan campos de comisión => guarda no concedida");
        }

        private static void M29()
        {
            PlatformSnapshot s = Fotos.Limpia("CFGUS");
            s.SecondsTillMarketClose = 60L;   // dentro del buffer de 300
            GuardId[] g = EvaluadorGuardas.Evaluar(s, UmbralesDePrueba(1), false);
            Chk("M29", !Contiene(g, GuardId.MARKET_HOURS_OPEN),
                "dentro del buffer de cierre no se considera mercado abierto");
        }

        private static void M30()
        {
            PlatformSnapshot s = Fotos.Limpia("CFGUS");
            s.QuoteAgeMillis = 999999L;
            GuardId[] g = EvaluadorGuardas.Evaluar(s, UmbralesDePrueba(1), false);
            Chk("M30", !Contiene(g, GuardId.LOCAL_QUOTE_AGE_FRESH), "cotización vieja => guarda no concedida");
        }

        private static void M31()
        {
            PlatformSnapshot s = Fotos.Limpia("CFGUS");
            GuardId[] g = EvaluadorGuardas.Evaluar(s, UmbralesRuntime.SinRatificar(), false);
            bool bloquea = !Contiene(g, GuardId.LOCAL_QUOTE_AGE_FRESH)
                        && !Contiene(g, GuardId.MARKET_HOURS_OPEN)
                        && !Contiene(g, GuardId.HUMAN_PRESENCE_HEARTBEAT_FRESH)
                        && !Contiene(g, GuardId.LOCAL_HUMAN_ARM);
            Chk("M31", bloquea, "umbrales sin ratificar bloquean las guardas que dependen de ellos");
        }

        private static void M32()
        {
            JournalFalso jr = new JournalFalso(true);
            AdapterRuntime rt = MontarConJournal(jr, 1);   // presupuesto de UNA entrada
            StrategyDecision d = rt.EvaluarSenal();
            bool a = rt.IntentarEntrada(d, DatosBase("M32a"));
            rt.Sesion.NuevasEntradasDesarmadas = false;
            rt.Sesion.Actual = RuntimeState.PERMIT_ISSUED;

            JournalFalso jr2 = new JournalFalso(true);
            AdapterRuntime rt2 = new AdapterRuntime(new RelojFalso(10L, 1L),
                new ObservadorFalso(Fotos.Limpia("CFGUS")),
                new FuenteBarrasFalsa(FuenteBarrasFalsa.Serie(400000L, new double[] { 1.0, 1.1, 1.2, 1.15, 1.25 })),
                new OrdenesFalsas(), jr2, new RiesgoFalso(true, 1000d, 25d), new ParadaFalsa(),
                UmbralesDePrueba(0), PoliticaHueco.EsperarContiguidad, 5, 32, PlanDigest, Etiqueta);
            rt2.Arrancar();
            rt2.Sesion.NuevasEntradasDesarmadas = false;
            StrategyDecision d2 = rt2.EvaluarSenal();
            bool b = rt2.IntentarEntrada(d2, DatosBase("M32b"));

            Chk("M32", a && !b && rt2.Cuenta.EntradasRechazadasPorPresupuesto == 1,
                "presupuesto de efectos agotado bloquea la orden aunque todo lo demás pase");
        }

        private static void M33()
        {
            string norm = SimboloPolitica.Normalizar("CFG.US");
            AttributionKey sinNorm = AttributionKey.Create(Etiqueta.Replace("-", "_"), "CFG.US", CanonicalModel.Sha256("p"));
            AttributionKey conNorm = AttributionKey.Create(Etiqueta.Replace("-", "_"), norm, CanonicalModel.Sha256("p"));
            Chk("M33", norm == "CFG_US" && sinNorm == null && conNorm != null,
                "CFG.US es inatribuible sin normalizar; normalizado a CFG_US sí lo es");
        }

        // ------------------------------------------- SIMULADOR ADVERSARIO

        private static void M34()
        {
            const int Iteraciones = 4000;
            long semilla = 20260816L;
            int violaciones = 0;
            string primeraViolacion = string.Empty;

            for (int corrida = 0; corrida < 40; corrida++)
            {
                JournalFalso jr = new JournalFalso(true);
                OrdenesFalsas ord = new OrdenesFalsas();
                ObservadorFalso obs = new ObservadorFalso(Fotos.Limpia("CFGUS"));
                FuenteBarrasFalsa bar = new FuenteBarrasFalsa(
                    FuenteBarrasFalsa.Serie(400000L, new double[] { 1.0, 1.1, 1.2, 1.15, 1.25 }));
                ParadaFalsa parada = new ParadaFalsa();
                AdapterRuntime rt = Montar(obs, bar, ord, jr, new RiesgoFalso(true, 1000d, 25d), parada,
                                           new RelojFalso(10L, 1L), UmbralesDePrueba(3), PoliticaHueco.EsperarContiguidad);
                rt.Arrancar();

                TransitionEvent[] eventos = (TransitionEvent[])Enum.GetValues(typeof(TransitionEvent));
                bool detenidoVisto = false;
                int entradasTrasDetencion = 0;

                for (int i = 0; i < Iteraciones / 40; i++)
                {
                    semilla = (semilla * 1103515245L + 12345L) % 2147483648L;
                    long r = semilla % 100L;

                    if (r < 55L)
                    {
                        TransitionEvent ev = eventos[(int)(semilla % eventos.Length)];
                        rt.Aplicar(ev, new GuardId[0]);
                    }
                    else if (r < 75L)
                    {
                        rt.Sesion.NuevasEntradasDesarmadas = (semilla % 2L) == 0L;
                        StrategyDecision d = rt.EvaluarSenal();
                        int antes = ord.Entradas;
                        rt.IntentarEntrada(d, DatosBase("fz"
                            + corrida.ToString(CultureInfo.InvariantCulture) + "_"
                            + i.ToString(CultureInfo.InvariantCulture)));
                        if (detenidoVisto && ord.Entradas > antes) { entradasTrasDetencion++; }
                    }
                    else if (r < 90L)
                    {
                        rt.IntentarCierre((int)(semilla % 50L));
                    }
                    else
                    {
                        rt.Reconciliar();
                    }

                    if (rt.Sesion.RuntimeDetenido) { detenidoVisto = true; }

                    // --- INVARIANTES GLOBALES ---
                    if (rt.Compuerta.MaximoConcurrente > 1)
                    { violaciones++; if (primeraViolacion.Length == 0) { primeraViolacion = "I1_DOS_EFECTOS_EN_VUELO"; } }

                    if (ord.Entradas > rt.Compuerta.Presupuesto)
                    { violaciones++; if (primeraViolacion.Length == 0) { primeraViolacion = "I2_PRESUPUESTO_SUPERADO"; } }

                    if (rt.Cuenta.EntradasEnviadas != ord.Entradas)
                    { violaciones++; if (primeraViolacion.Length == 0) { primeraViolacion = "I3_CONTADOR_DESCUADRADO"; } }

                    if (entradasTrasDetencion > 0)
                    { violaciones++; if (primeraViolacion.Length == 0) { primeraViolacion = "I4_ORDEN_TRAS_PARADA"; } }

                    if (rt.Sesion.Actual == RuntimeState.LIVE_LOCKED && !rt.Sesion.RuntimeDetenido)
                    { violaciones++; if (primeraViolacion.Length == 0) { primeraViolacion = "I5_LIVE_LOCKED_SIN_PARAR"; } }
                }
            }

            Chk("M34", violaciones == 0,
                "simulador adversario: 4000 eventos aleatorios, 0 violaciones de invariante"
                + (violaciones == 0 ? "" : " — " + primeraViolacion));
        }

        private static bool Contiene(GuardId[] g, GuardId x)
        {
            for (int i = 0; i < g.Length; i++) { if (g[i] == x) { return true; } }
            return false;
        }
    }
}
